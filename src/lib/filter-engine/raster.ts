export function createImageDataFromImage(
  image: HTMLImageElement,
  maxDimension?: number,
): ImageData {
  const scale =
    maxDimension && Math.max(image.width, image.height) > maxDimension
      ? maxDimension / Math.max(image.width, image.height)
      : 1;

  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create canvas context");
  }

  context.drawImage(image, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}
