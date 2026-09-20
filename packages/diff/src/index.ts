export { diffProse, diffWords, type ProseDiff, type SentenceChange, type WordRun, type ChangeKind } from "./prose-diff.js";
export { diffSequences, type Op } from "./myers.js";
export { similarity, containment, tokens } from "./similarity.js";
export {
  diffPlanToProse, paragraphsOf, scorePair, pairScore, computeDivergence,
  beatsForChapter, chapterIdForPath,
  DERIVATION_ALGO_VERSION, THRESHOLDS,
  type PlanDiff, type Derivation, type Divergence, type Paragraph, type PairScore,
  type Relation, type Method,
} from "./derivation.js";
