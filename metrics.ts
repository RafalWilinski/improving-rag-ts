import * as lancedb from "@lancedb/lancedb";
import cliProgress from "cli-progress";
import { readFileSync } from "fs";

const db = await lancedb.connect("./data/lancedb");
const reviewsTable = await db.openTable("reviews");

interface EvalQuestion {
  question: string;
  answer: string;
  chunkId: string;
}

const syntheticQuestions: EvalQuestion[] = JSON.parse(
  readFileSync("./synthetic_evals.json", "utf8")
);

async function simpleRequest(q: EvalQuestion, n: number = 5): Promise<string[]> {
  // Sometimes the search hangs indefinitely, so we set a timeout and return an empty array if the search takes too long
  const results = await Promise.race([
    reviewsTable.search(q.question).limit(n).toArray(),
    new Promise<[]>((_, reject) => setTimeout(() => reject(new Error("Search timeout")), 5000)),
  ]).catch(() => []);
  return results.map((r) => (q.chunkId === r.id ? r.id : ""));
}

async function score(hits: string[][]) {
  const nRetrieved = hits.length;
  const totalRetrievals = hits.reduce((acc, curr) => acc + curr.length, 0);
  const truePositives = hits.reduce(
    (acc, curr) => acc + curr.filter((hit) => hit !== "").length,
    0
  );

  const precision = totalRetrievals > 0 ? truePositives / totalRetrievals : 0;
  const recall = nRetrieved > 0 ? truePositives / nRetrieved : 0;
  return { precision, recall };
}

const multibar = new cliProgress.MultiBar(
  {
    clearOnComplete: false,
    hideCursor: true,
    format: " {bar} | {k} | {value}/{total}",
  },
  cliProgress.Presets.shades_classic
);

async function scoreSimpleSearch(n: number): Promise<{ precision: number; recall: number }> {
  const progressBar = multibar.create(syntheticQuestions.length, 0, { k: n });

  const hits = [];
  for (const q of syntheticQuestions) {
    hits.push(await simpleRequest(q, n));
    progressBar.increment();
  }

  progressBar.stop();

  return score(hits);
}

const k_to_retrieve = [2, 5, 10, 15];
console.log("Scoring simple search for k = ", k_to_retrieve);
const scores = await Promise.all(k_to_retrieve.map((n) => scoreSimpleSearch(n)));
const scoresWithRetrieved = scores.map((score, index) => ({
  ...score,
  n_retrieved: k_to_retrieve[index],
}));
multibar.stop();

console.table(scoresWithRetrieved);

/**
┌───┬─────────────────────┬────────────────────┬─────────────┐
│   │ precision           │ recall             │ n_retrieved │
├───┼─────────────────────┼────────────────────┼─────────────┤
│ 0 │ 0.38345864661654133 │ 0.7555555555555555 │ 2           │
│ 1 │ 0.19850746268656716 │ 0.9851851851851852 │ 5           │
│ 2 │ 0.1                 │ 0.9851851851851852 │ 10          │
│ 3 │ 0.06666666666666667 │ 0.9925925925925926 │ 15          │
└───┴─────────────────────┴────────────────────┴─────────────┘
 */
