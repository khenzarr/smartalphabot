import type { SupportedChain } from '@prisma/client';
import { prisma } from '../prisma.js';

export async function createAnalysisJob(input: {
  chain: SupportedChain;
  jobType: string;
  targetType: string;
  targetValue: string;
  status: string;
  input?: unknown;
  warnings?: string[];
}) {
  return prisma.analysisJob.create({
    data: {
      chain: input.chain,
      jobType: input.jobType,
      targetType: input.targetType,
      targetValue: input.targetValue,
      status: input.status,
      input: input.input as object | undefined,
      warnings: input.warnings ?? [],
    },
  });
}

export async function updateAnalysisJobResult(input: {
  id: string;
  status: string;
  result?: unknown;
  warnings?: string[];
  error?: string;
}) {
  return prisma.analysisJob.update({
    where: { id: input.id },
    data: {
      status: input.status,
      result: input.result as object | undefined,
      warnings: input.warnings ?? [],
      error: input.error,
    },
  });
}
