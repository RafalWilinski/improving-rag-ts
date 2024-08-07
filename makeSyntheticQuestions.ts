import * as lancedb from "@lancedb/lancedb";
import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { writeFileSync } from "fs";

interface Review {
  id: string;
  productTitle: string;
  review: string;
  productDescription: string;
}

const db = await lancedb.connect("./data/lancedb");
const reviewsTable = await db.openTable("reviews");
const reviews: Review[] = await reviewsTable.query().limit(10).toArray();

const numberOfQuestions = 2;
const example_questions = [
  "What does the reviewer like about the product?",
  "What does the reviewer think could be improved?",
];

async function generateEvals(review: Review, exampleQuestions: string[]) {
  const prompt = `
  Generate \`${numberOfQuestions}\` question-answer pairs about a ${
    review.productTitle
  }. The answers should primarily be derived from information in this product review:

  <content>
  ${review.review}
  </content>

  While they should contain information from the product review, you may also find it helpful context to see a product description:
  <content>
  ${review.productDescription}
  </content>

  Example questions:
  ${example_questions.map((q) => `- ${q}`).join("\n")}

  Provide a concise and specific answer for each question.
  Do not use the exact example questions. Use them only as inspiration for the types of more specific questions to generate.
  Do not include answers that are not in the content.
  Questions should ask about product characteristics (e.g. durability) and answers should refer to product characteristics without referring to the reviewer specifically.
  Stylistically, the questions should resemble what people would ask a RAG-based answer bot on a retailer's website. So they can be a little informal, messy or scattered.
`;

  const response = await generateObject({
    prompt,
    model: openai("gpt-4o-2024-08-06"),
    schema: z.object({
      questionAnswers: z.array(
        z.object({
          question: z.string(),
          answer: z.string(),
        })
      ),
    }),
  });

  return response.object.questionAnswers.map((qa) => ({
    ...qa,
    chunkId: review.id,
  }));
}

const allEvals = await Promise.all(
  reviews.flatMap(async (review) => {
    const evals = [];
    for (let i = 0; i < numberOfQuestions; i++) {
      const questionAnswer = await generateEvals(review, example_questions);
      evals.push(questionAnswer);
    }
    return evals;
  })
);

const flattenedEvals = allEvals.flat();

console.log(`Generated ${flattenedEvals.length} evaluation questions and answers.`);
writeFileSync(`./synthetic_evals.json`, JSON.stringify(flattenedEvals, null, 2));

console.table(flattenedEvals);
