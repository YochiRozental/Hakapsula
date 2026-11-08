"use client";

import { useCallback, useEffect } from "react";
import Image from "next/image";
import { Icon } from "@/components/ui";
import type { GalleryImageItem } from "@/components/gallery/gallery-grid";

export function Lightbox({
  images,
  index,
  onClose,
  onIndexChange,
}: {
  images: GalleryImageItem[];
  index: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}) {
  const goPrev = useCallback(
    () => onIndexChange((index - 1 + images.length) % images.length),
    [index, images.length, onIndexChange],
  );
  const goNext = useCallback(() => onIndexChange((index + 1) % images.length), [index, images.length, onIndexChange]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      // התפריט מאותת "קודם"/"הבא" עם צ'ברון ימני/שמאלי (RTL) — מקשי החצים תואמים לאותה סמנטיקה
      else if (event.key === "ArrowLeft") goNext();
      else if (event.key === "ArrowRight") goPrev();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, goNext, goPrev]);

  const image = images[index];
  if (!image) return null;

  const aspect = image.width && image.height ? image.width / image.height : 4 / 3;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="תצוגה מוגדלת של תמונה"
      className="fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center p-4 sm:p-8"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="סגירה"
        className="absolute top-4 left-4 sm:top-6 sm:left-6 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
      >
        <Icon name="x" className="w-5 h-5" />
      </button>

      {images.length > 1 && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              goPrev();
            }}
            aria-label="התמונה הקודמת"
            className="absolute right-2 sm:right-6 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
          >
            <Icon name="chevronRight" className="w-6 h-6" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              goNext();
            }}
            aria-label="התמונה הבאה"
            className="absolute left-2 sm:left-6 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
          >
            <Icon name="chevronLeft" className="w-6 h-6" />
          </button>
        </>
      )}

      <div
        className="relative w-full max-w-4xl max-h-[75vh] sm:max-h-[80vh]"
        style={{ aspectRatio: aspect }}
        onClick={(e) => e.stopPropagation()}
      >
        <Image
          src={image.url}
          alt={image.title ?? "תמונה מגלריית הקליניקות"}
          fill
          sizes="100vw"
          className="object-contain"
          priority
        />
      </div>

      {(image.title || image.description) && (
        <div className="mt-4 text-center text-white max-w-2xl px-4" onClick={(e) => e.stopPropagation()}>
          {image.title && <p className="font-display text-lg font-bold">{image.title}</p>}
          {image.description && <p className="text-sm text-white/70 mt-1">{image.description}</p>}
        </div>
      )}

      {images.length > 1 && (
        <p className="mt-3 text-xs text-white/60 tabular-nums" dir="ltr" onClick={(e) => e.stopPropagation()}>
          {index + 1} / {images.length}
        </p>
      )}
    </div>
  );
}
