export function isImageFile(file: File) {
  return (
    /^image\/(?:jpeg|png|webp|gif)$/u.test(file.type) ||
    /\.(?:jpe?g|png|webp|gif)$/iu.test(file.name)
  );
}

export async function imageDimensions(file: File) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      const dimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return dimensions;
    } catch {
      // Fall through for browsers that cannot decode this file with ImageBitmap.
    }
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
