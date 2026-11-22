// Answers from plain functions: a keyword test, a regular expression, a model you host yourself.
// One function per question key. For tests, for questions a rule answers better than a model
// ("is this the STOP keyword?"), and as the way to plug in your own classifier.
import type { Labeler } from "../labeler.ts";
import type { Answer } from "../schema.ts";
import type { Json, ProbabilitySource } from "../types.ts";

/** A yes/no rule returns true, false or a probability; a choice rule an option key; a score rule a level index. */
export type Rule = (state: Json) => boolean | number | string;

/**
 * A labeler built from rules. `id` names it and its version, as a model's id would.
 * `probability` says what its numbers are: "none" for true/false rules, "native" when the rules
 * return real probabilities from a classifier.
 */
export const ruleLabeler = ({ id, answer, probability = "none" }: { id: string; answer: Readonly<Record<string, Rule>>; probability?: ProbabilitySource }): Labeler => ({
  id,
  probability,
  label: async (state, questions) => ({
    cost: 0,
    answers: Object.fromEntries(
      Object.entries(questions).map(([key, question]): [string, Answer] => {
        const rule = answer[key];
        if (!rule) {
          throw new Error(`No rule answers "${key}"`);
        }
        const value = rule(state);
        if (question.type === "boolean") {
          return [key, { type: "boolean", probability: typeof value === "number" ? value : value === true ? 1 : 0 }];
        }
        if (question.type === "choice") {
          return [key, { type: "choice", choice: String(value) }];
        }
        return [key, { type: "score", score: Number(value) }];
      }),
    ),
  }),
});
