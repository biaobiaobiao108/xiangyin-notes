import type { JSONContent } from "@tiptap/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";

type UseDeferredImagesOptions = {
  currentUserKey: string;
  notifyInfo: (message: string) => void;
  notifyWarning: (message: string) => void;
};

/**
 * 管理切篇或上传期间延迟插入的图片队列，并在 sessionStorage 中做刷新恢复。
 */
export function useDeferredImages({
  currentUserKey,
  notifyInfo,
  notifyWarning,
}: UseDeferredImagesOptions) {
  const deferredImagesRef = useRef(new Map<string, JSONContent[]>());
  const [deferredImages, setDeferredImages] = useState<ReadonlyMap<string, JSONContent[]>>(
    () => new Map(),
  );
  const deferredImagesKey = `xiangying_deferred_images:${currentUserKey}`;

  useEffect(() => {
    if (!currentUserKey) return;
    try {
      const stored = sessionStorage.getItem(deferredImagesKey);
      if (stored) {
        const pending = new Map<string, JSONContent[]>(JSON.parse(stored));
        deferredImagesRef.current = pending;
        setDeferredImages(new Map(pending));
      }
    } catch {
      notifyWarning("无法恢复待插入的图片，请检查浏览器存储");
    }
  }, [currentUserKey, deferredImagesKey, notifyWarning]);

  const updateDeferredImages = useCallback(() => {
    const pending = deferredImagesRef.current;
    setDeferredImages(new Map(pending));
    try {
      if (pending.size) sessionStorage.setItem(deferredImagesKey, JSON.stringify([...pending]));
      else sessionStorage.removeItem(deferredImagesKey);
      return true;
    } catch {
      return false;
    }
  }, [deferredImagesKey]);

  const onDeferImage = useCallback(
    (noteId: string, image: JSONContent) => {
      const pending = deferredImagesRef.current;
      pending.set(noteId, [...(pending.get(noteId) ?? []), image]);
      if (updateDeferredImages()) notifyInfo("图片已上传，将补入原笔记文末");
      else notifyWarning("图片已上传，请在刷新前返回原笔记以插入图片");
    },
    [notifyInfo, notifyWarning, updateDeferredImages],
  );

  const insertDeferredImages = useCallback(
    (noteId: string, insert: (images: JSONContent[]) => boolean) => {
      const pending = deferredImagesRef.current;
      const images = pending.get(noteId);
      if (!images?.length || !insert(images)) return;
      pending.delete(noteId);
      updateDeferredImages();
    },
    [updateDeferredImages],
  );

  const onBackgroundImageError = useCallback(
    (filename: string) => notifyWarning(`图片上传失败：${filename}`),
    [notifyWarning],
  );

  const handleUploadImage = useCallback((file: File) => api.uploadAsset(file), []);

  return {
    deferredImages,
    onDeferImage,
    insertDeferredImages,
    onBackgroundImageError,
    handleUploadImage,
  };
}
