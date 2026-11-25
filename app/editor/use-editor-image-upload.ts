import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { Editor, JSONContent } from "@tiptap/core";
import { IMAGE_MAX_BYTES, type ImageAssetSummary } from "../../shared/types";
import { imageDimensions, isImageFile } from "./image-files";
import { createImageUploadPosition } from "./image-upload-position";

type UploadImage = (
  file: File,
  dimensions: { width: number; height: number },
) => Promise<{ asset: ImageAssetSummary }>;

export function useEditorImageUpload({
  editorInstanceRef,
  noteId,
  reloadToken,
  deleted,
  locked,
  onUploadImage,
  onDeferImage,
  onBackgroundImageError,
}: {
  editorInstanceRef: { current: Editor | null };
  noteId: string;
  reloadToken: number;
  deleted: boolean;
  locked: boolean;
  onUploadImage?: UploadImage;
  onDeferImage: (noteId: string, image: JSONContent) => void;
  onBackgroundImageError: (filename: string) => void;
}) {
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const imageUploadMessageRef = useRef<HTMLDivElement>(null);
  const imageUploadMessageId = useId();
  const imageUploadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uploadImageFilesRef = useRef<(files: File[]) => void>(() => undefined);
  const uploadLockedRef = useRef(false);
  uploadLockedRef.current = locked || deleted;
  const onUploadImageRef = useRef(onUploadImage);
  const imageUploadContextRef = useRef({ noteId, reloadToken });
  if (
    imageUploadContextRef.current.noteId !== noteId ||
    imageUploadContextRef.current.reloadToken !== reloadToken
  ) {
    imageUploadContextRef.current = { noteId, reloadToken };
  }
  const imageUploadProgressRef = useRef({
    context: imageUploadContextRef.current,
    activeCount: 0,
    failed: false,
  });
  if (imageUploadProgressRef.current.context !== imageUploadContextRef.current) {
    imageUploadProgressRef.current = {
      context: imageUploadContextRef.current,
      activeCount: 0,
      failed: false,
    };
  }
  const [imageUploadState, setImageUploadState] = useState<"idle" | "uploading" | "error">("idle");
  const [imageUploadMessage, setImageUploadMessage] = useState("");
  const clearImageUploadMessage = useCallback(() => setImageUploadMessage(""), []);

  useEffect(() => {
    onUploadImageRef.current = onUploadImage;
  }, [onUploadImage]);

  const uploadImageFiles = useCallback(
    async (files: File[]) => {
      const editorInstance = editorInstanceRef.current;
      const uploadImage = onUploadImageRef.current;
      const uploadContext = imageUploadContextRef.current;
      const isCurrentUpload = () =>
        imageUploadContextRef.current === uploadContext &&
        editorInstanceRef.current === editorInstance &&
        !editorInstance?.isDestroyed;
      if (!editorInstance || !uploadImage || locked || deleted) return;
      const oversized = files.filter((file) => isImageFile(file) && file.size > IMAGE_MAX_BYTES);
      const imageFiles = files.filter((file) => isImageFile(file) && file.size <= IMAGE_MAX_BYTES);
      if (oversized.length)
        setImageUploadMessage(
          `超过 25 MiB，未上传：${oversized.map((file) => file.name).join("、")}`,
        );
      else setImageUploadMessage("");
      if (!imageFiles.length) {
        if (files.some(isImageFile)) {
          const progress = imageUploadProgressRef.current;
          progress.failed = true;
          if (progress.activeCount === 0) setImageUploadState("error");
          if (imageUploadTimerRef.current !== null) clearTimeout(imageUploadTimerRef.current);
          imageUploadTimerRef.current =
            progress.activeCount === 0
              ? setTimeout(() => {
                  imageUploadTimerRef.current = null;
                  if (imageUploadProgressRef.current === progress && progress.activeCount === 0) {
                    progress.failed = false;
                    setImageUploadState("idle");
                  }
                }, 3000)
              : null;
        }
        return;
      }
      const uploadPosition = createImageUploadPosition(editorInstance);
      const progress = imageUploadProgressRef.current;
      if (progress.activeCount === 0) progress.failed = false;
      if (oversized.length) progress.failed = true;
      progress.activeCount += 1;
      setImageUploadState("uploading");
      if (imageUploadTimerRef.current !== null) clearTimeout(imageUploadTimerRef.current);
      imageUploadTimerRef.current = null;
      const maxWidth = Math.max(
        1,
        editorInstance.view.dom.closest(".note-prose")?.getBoundingClientRect().width ?? 820,
      );
      try {
        for (const file of imageFiles) {
          try {
            const dimensions = await imageDimensions(file);
            const result = await uploadImage(file, dimensions);
            const width = Math.min(maxWidth, Math.max(1, dimensions.width));
            const height = Math.max(
              1,
              Math.round((width * dimensions.height) / Math.max(1, dimensions.width)),
            );
            const image = {
              type: "image",
              attrs: {
                assetId: result.asset.id,
                src: result.asset.url,
                alt: result.asset.originalName.replace(/\.[^.]+$/u, "") || "图片",
                width,
                height,
              },
            };
            if (!isCurrentUpload() || !uploadPosition.insert(image)) {
              onDeferImage(uploadContext.noteId, image);
            }
          } catch {
            if (!isCurrentUpload()) {
              onBackgroundImageError(file.name);
            } else {
              progress.failed = true;
              setImageUploadMessage(
                (message) => `${message}${message ? "；" : ""}上传失败：${file.name}`,
              );
            }
          }
        }
      } finally {
        uploadPosition.dispose();
        if (
          imageUploadProgressRef.current === progress &&
          editorInstanceRef.current === editorInstance &&
          !editorInstance.isDestroyed
        ) {
          progress.activeCount = Math.max(0, progress.activeCount - 1);
          if (progress.activeCount === 0) {
            if (progress.failed) {
              setImageUploadState("error");
              imageUploadTimerRef.current = setTimeout(() => {
                imageUploadTimerRef.current = null;
                if (imageUploadProgressRef.current === progress && progress.activeCount === 0) {
                  progress.failed = false;
                  setImageUploadState("idle");
                }
              }, 3000);
            } else {
              setImageUploadState("idle");
            }
          }
        }
      }
    },
    [deleted, editorInstanceRef, locked, onBackgroundImageError, onDeferImage],
  );
  uploadImageFilesRef.current = (files) => {
    void uploadImageFiles(files);
  };

  useLayoutEffect(() => {
    if (imageUploadTimerRef.current !== null) {
      clearTimeout(imageUploadTimerRef.current);
      imageUploadTimerRef.current = null;
    }
    setImageUploadState("idle");
    setImageUploadMessage("");
  }, [noteId, reloadToken]);

  useEffect(
    () => () => {
      if (imageUploadTimerRef.current !== null) clearTimeout(imageUploadTimerRef.current);
    },
    [],
  );

  return {
    imageFileInputRef,
    imageUploadMessageRef,
    imageUploadMessageId,
    uploadImageFilesRef,
    imageUploadState,
    imageUploadMessage,
    clearImageUploadMessage,
  };
}
