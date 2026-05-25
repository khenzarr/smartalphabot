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
      reasons.push('no_tx_context_available');
    } else if (likelyBuyMajority && knownRouterSeen && !airdropMajority) {
      activityType = 'likely_buy';
      reasons.push('likely_buy_majority_detected');
      reasons.push('known_router_seen');
    } else if (airdropMajority) {
      activityType = 'airdrop_or_claim';
      reasons.push('airdrop_or_claim_majority_detected');
    } else if (hasLikelyBuy && (hasMixedComposition || !likelyBuyMajority)) {
      activityType = 'mixed_activity';
      reasons.push('mixed_activity_detected');
    } else if (transferEventCount > 0) {
      activityType = 'transfer';
      reasons.push('transfer_activity_detected');
    } else if (contractInteractionEventCount > 0) {
      activityType = 'contract_interaction';
      reasons.push('contract_interaction_detected');
    }

    let confidence: MonitorSignal['confidence'] = 'low';
    if (activityType === 'likely_buy' && likelyBuyMajority && knownRouterSeen && !airdropMajority) confidence = 'high';
    else if (activityType === 'mixed_activity' || activityType === 'airdrop_or_claim') confidence = 'medium';
    else if (contextEventCount > 0 && mediumConfidenceEventCount >= lowConfidenceEventCount) confidence = 'medium';

    if (likelyBuyMajority && knownRouterSeen) {
      score += 30;
    } else if (hasLikelyBuy) {
      score += 8;
      reasons.push('likely_buy_detected_but_not_majority');
    }
    if (knownRouterSeen) {
      score += 10;
    } else if (contextEventCount > 0) {
      score -= 10;
      reasons.push('no_router_evidence');
    }
    if (activityType === 'mixed_activity') {
      score -= 12;
      reasons.push('manual_review_required');
    }
    if (activityType === 'airdrop_or_claim') {
      score -= 20;
      reasons.push('airdrop_or_claim_majority_penalty');
      reasons.push('manual_review_required');
    }
    if (unknownEventCount > 0) {
      score -= Math.min(12, unknownEventCount * 2);
      reasons.push('tx_context_unknown');
    }
    if (confidence === 'low') {
      score -= 10;
      reasons.push('low_context_confidence');
    }

    if (wallets.length >= 2) {
      score += 25;
      reasons.push('multiple_watched_wallet_overlap');
    } else {
      score -= 15;
      reasons.push('single_wallet_only');
    }
    if ((sample.marketCap ?? Number.MAX_SAFE_INTEGER) < 5_000_000) {
      score += 15;
      reasons.push('marketcap_under_5m');
    } else if ((sample.marketCap ?? 0) > 200_000_000) {
      score -= 15;
      reasons.push('high_market_cap');
    }
    if ((sample.liquidityUsd ?? 0) > 100_000) {
      score += 10;
      reasons.push('liquidity_over_100k');
    }
    if ((sample.tokenAgeSeconds ?? Number.MAX_SAFE_INTEGER) < 24 * 3600) {
      score += 20;
      reasons.push('token_age_under_24h');
    } else if ((sample.tokenAgeSeconds ?? Number.MAX_SAFE_INTEGER) < 72 * 3600) {
      score += 12;
      reasons.push('token_age_under_72h');
    } else if ((sample.tokenAgeSeconds ?? Number.MAX_SAFE_INTEGER) < 7 * 24 * 3600) {
      score += 6;
      reasons.push('token_age_under_7d');
    }

    const avgWalletScore = rows.reduce((acc, r) => acc + (r.walletScore ?? 0), 0) / Math.max(rows.length, 1);
    score += Math.min(20, Math.floor(avgWalletScore / 5));
    reasons.push('wallet_discovery_score_weighted');

    if (!sample.symbol && !sample.name) {
      score -= 12;
      reasons.push('missing_market_profile');
    }
    if ((sample.liquidityUsd ?? 0) < 20_000) {
      score -= 12;
      reasons.push('liquidity_under_20k');
    }
    if ((sample.tokenAgeSeconds ?? 0) > 30 * 24 * 3600) {
      score -= 20;
      reasons.push('old_token');
    }
    if (IGNORED_TOKEN_SYMBOLS.has(symbolLower)) {
      bumpDropReason('stablecoin_or_wrapped_token');
      continue;
    }

    let category: MonitorSignal['category'] = 'weak_signal';
    if (score >= 60) category = 'strong_signal';
    else if (score >= 35) category = 'watch_signal';
    else if (score <= 0) category = 'ignored';

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
