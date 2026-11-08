"use client";

import { useState } from "react";
import Image from "next/image";
import { Lightbox } from "@/components/gallery/lightbox";

export type GalleryImageItem = {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
  title: string | null;
  description: string | null;
};

export function GalleryGrid({ images }: { images: GalleryImageItem[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
        {images.map((image, index) => (
          <button
            key={image.id}
            type="button"
            onClick={() => setOpenIndex(index)}
            className="group relative aspect-square overflow-hidden rounded-2xl ring-1 ring-cream-300/70 shadow-soft bg-cream-100 cursor-zoom-in"
            aria-label={image.title ? `הגדלת התמונה: ${image.title}` : "הגדלת התמונה"}
          >
            <Image
              src={image.url}
              alt={image.title ?? "תמונה מגלריית הקליניקות"}
              fill
              sizes="(min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw"
              className="object-cover transition-transform duration-300 group-hover:scale-105"
              loading="lazy"
            />
            {image.title && (
              <span className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/60 to-transparent text-white text-xs sm:text-sm font-semibold px-3 py-2 truncate text-right">
                {image.title}
              </span>
            )}
          </button>
        ))}
      </div>

      {openIndex !== null && (
        <Lightbox
          images={images}
          index={openIndex}
          onClose={() => setOpenIndex(null)}
          onIndexChange={setOpenIndex}
        />
      )}
    </>
  );
}
