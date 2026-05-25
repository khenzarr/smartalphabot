import type { EnrichedTokenEvent, MonitorSignal } from './monitoring.types.js';
import { IGNORED_TOKEN_SYMBOLS } from './constants.js';

const SUPPORTED_CHAINS = new Set(['ethereum', 'base', 'bsc']);

export interface BuildSignalsResult {
  signals: MonitorSignal[];
  groupsBuilt: number;
  groupsDropped: number;
  dropReasons: Record<string, number>;
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function pushUnique(target: string[], ...items: string[]) {
  for (const item of items) {
    if (item && !target.includes(item)) target.push(item);
  }
}

export function buildSignals(events: EnrichedTokenEvent[]): MonitorSignal[] {
  return buildSignalsWithStats(events).signals;
}

export function buildSignalsWithStats(events: EnrichedTokenEvent[]): BuildSignalsResult {
  const grouped = new Map<string, EnrichedTokenEvent[]>();
  const dropReasons: Record<string, number> = {};

  const bumpDropReason = (reason: string) => {
    dropReasons[reason] = (dropReasons[reason] ?? 0) + 1;
  };

  for (const event of events) {
    if (!event?.tokenAddress) {
      bumpDropReason('missing_token_address');
      continue;
    }
    if (!SUPPORTED_CHAINS.has(event.chain)) {
      bumpDropReason('unsupported_chain');
      continue;
    }
    const key = `${event.chain}:${event.tokenAddress.toLowerCase()}`;
    const list = grouped.get(key) ?? [];
    list.push(event);
    grouped.set(key, list);
  }

  const out: MonitorSignal[] = [];

  for (const [key, rows] of grouped) {
    if (!rows.length) {
      bumpDropReason('no_events');
      continue;
    }
    const sample = rows[0];
    const wallets = uniq(rows.map((x) => x.walletAddress.toLowerCase()));
    const uniqueTx = uniq(rows.map((x) => x.txHash.toLowerCase()));
    const warnings = uniq(rows.flatMap((x) => x.warnings));
    const symbolLower = (sample.symbol ?? '').toLowerCase();

    let score = 0;
    const reasons: string[] = [];
    const positiveReasons: string[] = [];
    const negativeReasons: string[] = [];
    const promotionBlockers: string[] = [];
    const qualityNotes: string[] = [];
    const riskFlags: string[] = [];
    const txContexts = rows.map((x) => x.transactionContext).filter((x): x is NonNullable<EnrichedTokenEvent['transactionContext']> => Boolean(x));
    const contextEventCount = txContexts.length;
    const likelyBuyEventCount = txContexts.filter((x) => x.likelyActivityType === 'likely_buy').length;
    const transferEventCount = txContexts.filter((x) => x.likelyActivityType === 'transfer').length;
    const airdropOrClaimEventCount = txContexts.filter((x) => x.likelyActivityType === 'airdrop_or_claim').length;
    const contractInteractionEventCount = txContexts.filter((x) => x.likelyActivityType === 'contract_interaction').length;
    const unknownFromContextEventCount = txContexts.filter((x) => x.likelyActivityType === 'unknown').length;
    const missingContextCount = rows.length - contextEventCount;
    const unknownEventCount = unknownFromContextEventCount + missingContextCount;
    const highConfidenceEventCount = txContexts.filter((x) => x.confidence === 'high').length;
    const mediumConfidenceEventCount = txContexts.filter((x) => x.confidence === 'medium').length;
    const lowConfidenceEventCount = txContexts.filter((x) => x.confidence === 'low').length + missingContextCount;
    const knownRouterEventCount = txContexts.filter((x) => x.knownRouterSeen).length;
    const knownRouterSeen = knownRouterEventCount > 0;
    const contextComposition: MonitorSignal['contextComposition'] = {
      likely_buy: likelyBuyEventCount,
      airdrop_or_claim: airdropOrClaimEventCount,
      transfer: transferEventCount,
      contract_interaction: contractInteractionEventCount,
      unknown: unknownEventCount,
    };

    const likelyBuyMajority = contextEventCount > 0 && likelyBuyEventCount > contextEventCount / 2;
    const airdropMajority = contextEventCount > 0 && airdropOrClaimEventCount > contextEventCount / 2;
    const hasLikelyBuy = likelyBuyEventCount > 0;
    const hasMixedComposition = contextEventCount > 0
      && [likelyBuyEventCount, transferEventCount, airdropOrClaimEventCount, contractInteractionEventCount, unknownFromContextEventCount].filter((n) => n > 0).length >= 2;

    let activityType: MonitorSignal['likelyActivityType'] = 'unknown';
    if (contextEventCount === 0) {
      activityType = 'unknown';
      pushUnique(negativeReasons, 'no_tx_context_available', 'market_data_missing');
    } else if (likelyBuyMajority && knownRouterSeen && !airdropMajority) {
      activityType = 'likely_buy';
      pushUnique(positiveReasons, 'likely_buy_context', 'known_router_seen');
    } else if (airdropMajority) {
      activityType = 'airdrop_or_claim';
      pushUnique(negativeReasons, 'airdrop_or_claim_dominant');
      pushUnique(riskFlags, 'airdrop_or_claim_dominant');
      pushUnique(promotionBlockers, 'airdrop_or_claim_dominant');
    } else if (hasLikelyBuy && (hasMixedComposition || !likelyBuyMajority)) {
      activityType = 'mixed_activity';
      pushUnique(qualityNotes, 'mixed_activity_detected');
    } else if (transferEventCount > 0) {
      activityType = 'transfer';
      pushUnique(qualityNotes, 'transfer_activity_detected');
    } else if (contractInteractionEventCount > 0) {
      activityType = 'contract_interaction';
      pushUnique(qualityNotes, 'contract_interaction_detected');
    }

    let confidence: MonitorSignal['confidence'] = 'low';
    if (activityType === 'likely_buy' && likelyBuyMajority && knownRouterSeen && !airdropMajority) confidence = 'high';
    else if (activityType === 'mixed_activity' || activityType === 'airdrop_or_claim') confidence = 'medium';
    else if (contextEventCount > 0 && mediumConfidenceEventCount >= lowConfidenceEventCount) confidence = 'medium';

    if (likelyBuyMajority && knownRouterSeen) {
      score += 30;
      pushUnique(positiveReasons, 'likely_buy_context');
    } else if (hasLikelyBuy) {
      score += 8;
      pushUnique(qualityNotes, 'likely_buy_detected_but_not_majority');
    }
    if (knownRouterSeen) {
      score += 10;
    } else if (contextEventCount > 0) {
      score -= 10;
      pushUnique(negativeReasons, 'no_router_evidence');
    }
    if (activityType === 'mixed_activity') {
      score -= 12;
      pushUnique(negativeReasons, 'manual_review_required');
    }
    if (activityType === 'airdrop_or_claim') {
      score -= 20;
      pushUnique(negativeReasons, 'airdrop_or_claim_majority_penalty', 'manual_review_required');
    }
    if (unknownEventCount > 0) {
      score -= Math.min(12, unknownEventCount * 2);
      pushUnique(negativeReasons, 'tx_context_unknown');
      pushUnique(qualityNotes, 'limited_context');
    }
    if (confidence === 'low') {
      score -= 10;
      pushUnique(negativeReasons, 'low_context_confidence');
    }

    if (wallets.length >= 2) {
      score += 25;
      pushUnique(positiveReasons, 'multi_wallet_consensus');
    } else {
      score -= 15;
      pushUnique(negativeReasons, 'single_wallet_only');
      pushUnique(promotionBlockers, 'single_wallet_only');
    }
    if ((sample.marketCap ?? Number.MAX_SAFE_INTEGER) < 5_000_000) {
      score += 15;
      pushUnique(positiveReasons, 'marketcap_under_5m');
    } else if ((sample.marketCap ?? 0) > 200_000_000) {
      score -= 15;
      pushUnique(negativeReasons, 'high_market_cap');
      pushUnique(riskFlags, 'high_market_cap');
    }
    if ((sample.liquidityUsd ?? 0) > 100_000) {
      score += 10;
      pushUnique(positiveReasons, 'liquidity_over_100k');
    } else if (sample.liquidityUsd == null) {
      pushUnique(negativeReasons, 'liquidity_unknown');
      pushUnique(qualityNotes, 'market_data_missing');
    }
    if ((sample.tokenAgeSeconds ?? Number.MAX_SAFE_INTEGER) < 24 * 3600) {
      score += 20;
      pushUnique(positiveReasons, 'token_age_under_24h');
    } else if ((sample.tokenAgeSeconds ?? Number.MAX_SAFE_INTEGER) < 72 * 3600) {
      score += 12;
      pushUnique(positiveReasons, 'token_age_under_72h');
    } else if ((sample.tokenAgeSeconds ?? Number.MAX_SAFE_INTEGER) < 7 * 24 * 3600) {
      score += 6;
      pushUnique(positiveReasons, 'token_age_under_7d');
    }

    const avgWalletScore = rows.reduce((acc, r) => acc + (r.walletScore ?? 0), 0) / Math.max(rows.length, 1);
    score += Math.min(20, Math.floor(avgWalletScore / 5));
    pushUnique(positiveReasons, 'wallet_discovery_score_weighted');
    if (avgWalletScore >= 75) pushUnique(positiveReasons, 'watchlist_wallet_score_high');
    if (avgWalletScore > 0 && avgWalletScore < 55) {
      pushUnique(negativeReasons, 'watchlist_wallet_score_low');
      pushUnique(promotionBlockers, 'watchlist_wallet_score_low');
    }

    if (!sample.symbol && !sample.name) {
      score -= 12;
      pushUnique(negativeReasons, 'market_data_missing', 'missing_market_profile');
    }
    if ((sample.liquidityUsd ?? 0) < 20_000) {
      score -= 12;
      pushUnique(negativeReasons, 'liquidity_under_20k');
      pushUnique(promotionBlockers, 'liquidity_under_20k');
    }
    if ((sample.tokenAgeSeconds ?? 0) > 30 * 24 * 3600) {
      score -= 20;
      pushUnique(negativeReasons, 'old_token');
    }
    if (IGNORED_TOKEN_SYMBOLS.has(symbolLower)) {
      pushUnique(riskFlags, 'stable_or_wrapped_token');
      pushUnique(negativeReasons, 'stable_or_wrapped_token');
      pushUnique(promotionBlockers, 'stable_or_wrapped_token');
    }

    if (confidence === 'high') pushUnique(positiveReasons, 'high_confidence_context');
    if (contextEventCount === 0) pushUnique(promotionBlockers, 'market_data_missing');

    let category: MonitorSignal['category'] = 'weak_signal';
    const stableOrWrapped = IGNORED_TOKEN_SYMBOLS.has(symbolLower);
    const nonAirdropEvents = Math.max(0, contextEventCount - airdropOrClaimEventCount);
    const strongLikelyBuy = activityType === 'likely_buy' && confidence !== 'low';
    const acceptableLiquidity = (sample.liquidityUsd ?? 0) >= 20_000 || sample.liquidityUsd == null;
    const notOldHighCap = (sample.marketCap ?? 0) < 200_000_000 || wallets.length >= 2;

    if (activityType === 'airdrop_or_claim' || stableOrWrapped) {
      category = 'ignored';
      pushUnique(negativeReasons, 'clearly_low_signal_activity');
    } else if (
      wallets.length >= 2
      && likelyBuyMajority
      && nonAirdropEvents > 0
      && (confidence === 'high' || confidence === 'medium')
      && acceptableLiquidity
      && notOldHighCap
    ) {
      category = 'strong_signal';
      pushUnique(positiveReasons, 'multi_wallet_consensus', 'likely_buy_context');
    } else if (
      (wallets.length >= 2 && nonAirdropEvents > 0)
      || (wallets.length === 1 && avgWalletScore >= 70 && strongLikelyBuy && acceptableLiquidity)
      || (wallets.length === 1 && rows.length >= 3 && strongLikelyBuy && !stableOrWrapped)
    ) {
      category = 'watch_signal';
      if (wallets.length === 1) pushUnique(qualityNotes, 'single_wallet_watch_upgrade');
    } else if (score <= 0) {
      category = 'ignored';
    }

    pushUnique(reasons, ...positiveReasons, ...negativeReasons, ...qualityNotes, ...promotionBlockers);


    out.push({
      chain: sample.chain,
      tokenAddress: sample.tokenAddress.toLowerCase(),
      symbol: sample.symbol,
      name: sample.name,
      watchedWalletCount: wallets.length,
      watchedWallets: wallets,
      firstSeenAt: rows.map((x) => x.observedAt).sort()[0] ?? new Date().toISOString(),
      latestSeenAt: rows.map((x) => x.observedAt).sort().slice(-1)[0] ?? new Date().toISOString(),
      txCount: rows.length,
      uniqueTxCount: uniqueTx.length,
      marketCap: sample.marketCap,
      liquidityUsd: sample.liquidityUsd,
      tokenAgeSeconds: sample.tokenAgeSeconds,
      warnings,
      score,
      category,
      reasons,
      positiveReasons,
      negativeReasons,
      promotionBlockers,
      qualityNotes,
      riskFlags,
      dexUrl: sample.dexUrl,
      likelyActivityType: activityType,
      confidence,
      knownRouterSeen,
      contextEventCount,
      likelyBuyEventCount,
      transferEventCount,
      airdropOrClaimEventCount,
      contractInteractionEventCount,
      unknownEventCount,
      highConfidenceEventCount,
      mediumConfidenceEventCount,
      lowConfidenceEventCount,
      knownRouterEventCount,
      contextComposition,
    });
  }

  const signals = out.sort((a, b) => b.score - a.score);
  const groupsBuilt = signals.length;
  const groupsDropped = Object.values(dropReasons).reduce((acc, n) => acc + n, 0);

  return {
    signals,
    groupsBuilt,
    groupsDropped,
    dropReasons,
  };
}
