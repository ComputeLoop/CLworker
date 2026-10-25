import { prepareImageClassifier } from "../ops/image-classify";

const modelPath = process.env.MODEL_PATH;
if (!modelPath) {
  throw new Error("MODEL_PATH is required for the DirectML inference preflight.");
}

await prepareImageClassifier({
  modelPath,
  labelsPath: process.env.MODEL_LABELS,
  backend: "directml",
});

console.log("DirectML model inference preflight succeeded.");
