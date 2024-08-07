import { generateObject } from "ai";
import { z } from "zod";
import cliProgress from "cli-progress";
import pLimit from "p-limit";
import * as lancedb from "@lancedb/lancedb";
import { LanceSchema, getRegistry } from "@lancedb/lancedb/lancedb/embedding";
import { Utf8 } from "apache-arrow";
import { openai } from "@ai-sdk/openai";
import { embed } from "ai";
import { writeFileSync } from "fs";

const productsCount = 10;

console.log(`Generating ${productsCount} products...`);
const { object } = await generateObject({
  model: openai("gpt-4o-mini"),
  prompt: `Create a list of ${productsCount} products someone might buy at a hardware store Each product title should be repeated 2-3 times. Do not have any with duplicate product descriptions.
  
So each product with a given title should have some small distinctions apparent from the description.\nProducts can be small (a screw), large (a bandsaw) or anywhere in between.

For each product, write a 2-3 sentence product description that might show up in a hardware retailers website underneath the product Do not create product reviews that contradict specific facts in other reviews. Contradicting subjective opinions in other reviews is ok only to the extent you would expect that in real data.Respond only with the list of products and descriptions.`,
  schema: z.object({
    products: z.array(
      z.object({
        title: z.string(),
        description: z.string(),
      })
    ),
  }),
});

const products = object.products;

async function makeReviews(product: { title: string; description: string }, reviewsCount: number) {
  const { title, description } = product;
  const { object } = await generateObject({
    model: openai("gpt-4o-mini"),
    prompt: `Write ${reviewsCount} realistic but detailed/specific product reviews that might show up on a hardware store's website. The reviews should be about the following product:
  
Product Title: ${title}
Product Description: ${description}

Add many relevant and concrete facts about the products (this is for synthetic data generation, make up facts about each product as necessary). To see the format of a possible review, here is a review for a saw:

"""
I've enjoyed using this saw. It is lightweight and the battery lasts longer than other brands. I've been using it for 3 years now and it has been very durable. It was twice as expensive as the PX-500. But it is comfortable to hold because of the light weight.
"""

Respond only with the reviews, and nothing else.`,
    schema: z.object({
      reviews: z.array(z.string()),
    }),
  });

  return {
    ...product,
    reviews: object.reviews,
  };
}

async function createReviewsDataset(
  products: Array<{ title: string; description: string }>,
  reviewsPerProduct: number = 3
) {
  const limit = pLimit(5); // Set concurrency to 5

  const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  progressBar.start(products.length, 0);

  const productsWithReviews = await Promise.all(
    products.map((product, index) =>
      limit(async () => {
        const result = await makeReviews(product, reviewsPerProduct);
        progressBar.update(index + 1);
        return result;
      })
    )
  );

  progressBar.stop();

  return productsWithReviews;
}

console.log("Generating reviews...");
const reviewsDataset = await createReviewsDataset(products);

console.log("Saving to Lancedb...");

const db = await lancedb.connect("./data/lancedb");

const func = getRegistry().get("openai")!.create({ model: "text-embedding-3-small" });

const productsSchema = LanceSchema({
  id: func.sourceField(new Utf8()),
  title: func.sourceField(new Utf8()),
  description: func.sourceField(new Utf8()),
  vector: func.vectorField(),
});
const reviewsSchema = LanceSchema({
  id: func.sourceField(new Utf8()),
  productTitle: func.sourceField(new Utf8()),
  productDescription: func.sourceField(new Utf8()),
  review: func.sourceField(new Utf8()),
  vector: func.vectorField(),
});

const reviewsTable = await db.createEmptyTable("reviews", reviewsSchema, {
  mode: "overwrite",
});
const productsTable = await db.createEmptyTable("products", productsSchema, {
  mode: "overwrite",
});

await productsTable.add(
  products.map((product, index) => ({
    id: index.toString(),
    title: product.title,
    description: product.description,
  }))
);
await reviewsTable.add(
  reviewsDataset.map((review, index) => ({
    id: index.toString(),
    productTitle: review.title,
    productDescription: review.description,
    review: review.reviews,
  }))
);

// Uncomment to search for a specific product
// const searchVector = await embed({
//   model: openai.embedding("text-embedding-3-small"),
//   value: "Cordless saw",
// });
// const results = await productsTable.vectorSearch(searchVector.embedding).limit(20).toArray();

writeFileSync("./reviews.json", JSON.stringify(reviewsDataset, null, 2));
console.log("Done!");
