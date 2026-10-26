const vision = require('@google-cloud/vision');

async function testOCR() {
  const client = new vision.ImageAnnotatorClient();

  const [result] = await client.textDetection('./test-id.jpg');

  const text = result.textAnnotations?.[0]?.description;

  console.log("\n===== OCR RESULT =====\n");
  console.log(text || "No text detected");
}

testOCR().catch((error) => {
  console.error("OCR ERROR:");
  console.error(error);
});