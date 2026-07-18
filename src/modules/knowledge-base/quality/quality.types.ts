export interface CoverageResult {
  score: number;
  passed: string[];
  failed: { category: string; asks: string }[];
  ruleKeys: string[];
}

export interface QualityReport extends CoverageResult {
  redundancyRatio: number;
  concisenessScore: number;
  duplicateChunkPairs: number;
  evaluatedAt: string;
}
