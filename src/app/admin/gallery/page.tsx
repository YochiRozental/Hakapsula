"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { Alert, EmptyState, Icon, Loading, PageHeader } from "@/components/ui";

type GalleryImage = {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
  title: string | null;
  description: string | null;
  sortOrder: number;
};

type PendingUpload = {
  key: string;
  file: File;
  previewUrl: string;
  title: string;
  description: string;
  status: "pending" | "uploading" | "error";
  error?: string;
};

export default function AdminGalleryPage() {
  const [images, setImages] = useState<GalleryImage[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [uploading, setUploading] = useState(false);
  const [reordering, setReordering] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragFromIndex = useRef<number | null>(null);

  function load() {
    fetch("/api/admin/gallery")
      .then((res) => res.json())
      .then((data) => setImages(Array.isArray(data) ? data : []))
      .catch(() => setListError("טעינת הגלריה נכשלה. נסו לרענן את הדף"));
  }

  useEffect(load, []);

  function onFilesSelected(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const next: PendingUpload[] = Array.from(fileList).map((file) => ({
      key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      previewUrl: URL.createObjectURL(file),
      title: "",
      description: "",
      status: "pending",
    }));
    setPending((prev) => [...prev, ...next]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function updatePending(key: string, patch: Partial<PendingUpload>) {
    setPending((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  }

  function removePending(key: string) {
    setPending((prev) => {
      const item = prev.find((p) => p.key === key);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((p) => p.key !== key);
    });
  }

  async function uploadOne(item: PendingUpload): Promise<boolean> {
    updatePending(item.key, { status: "uploading", error: undefined });
    const formData = new FormData();
    formData.append("file", item.file);
    if (item.title.trim()) formData.append("title", item.title.trim());
    if (item.description.trim()) formData.append("description", item.description.trim());

    try {
      const res = await fetch("/api/admin/gallery", { method: "POST", body: formData });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        updatePending(item.key, { status: "error", error: data?.error ?? "העלאה נכשלה" });
        return false;
      }
      setImages((prev) => [...(prev ?? []), data]);
      URL.revokeObjectURL(item.previewUrl);
      setPending((prev) => prev.filter((p) => p.key !== item.key));
      return true;
    } catch {
      updatePending(item.key, { status: "error", error: "העלאה נכשלה — בדקו את החיבור" });
      return false;
    }
  }

  async function uploadAll() {
    setUploading(true);
    const toUpload = pending.filter((p) => p.status !== "uploading");
    await Promise.all(toUpload.map(uploadOne));
    setUploading(false);
  }

  async function removeImage(image: GalleryImage) {
    if (!confirm(`למחוק את התמונה${image.title ? ` "${image.title}"` : ""}? הפעולה בלתי הפיכה.`)) return;
    const res = await fetch(`/api/admin/gallery/${image.id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error ?? "מחיקת התמונה נכשלה");
      return;
    }
    setImages((prev) => (prev ?? []).filter((img) => img.id !== image.id));
  }

  async function persistOrder(nextImages: GalleryImage[]) {
    setReordering(true);
    const res = await fetch("/api/admin/gallery/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedIds: nextImages.map((img) => img.id) }),
    });
    setReordering(false);
    if (!res.ok) {
      alert("שמירת הסדר החדש נכשלה. הרשימה תתרענן");
      load();
    }
  }

  function moveImage(index: number, direction: -1 | 1) {
    if (!images) return;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= images.length) return;
    const next = [...images];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    setImages(next);
    persistOrder(next);
  }

  function onDragStart(index: number) {
    dragFromIndex.current = index;
  }

  function onDragOver(e: DragEvent) {
    e.preventDefault();
  }

  function onDrop(index: number) {
    const from = dragFromIndex.current;
    dragFromIndex.current = null;
    if (from === null || from === index || !images) return;
    const next = [...images];
    const [moved] = next.splice(from, 1);
    next.splice(index, 0, moved);
    setImages(next);
    persistOrder(next);
  }

  return (
    <div>
      <PageHeader
        eyebrow="גלריית הקליניקות"
        title="ניהול גלריה"
        subtitle="הוספה, מחיקה וסידור התמונות שיוצגו בעמוד הגלריה הציבורי"
      />

      <section className="card p-5 mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="font-display text-lg font-bold text-stone-900">הוספת תמונות</h2>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              multiple
              className="hidden"
              onChange={(e) => onFilesSelected(e.target.files)}
            />
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileInputRef.current?.click()}>
              <Icon name="plus" className="w-4 h-4" />
              בחירת תמונות
            </button>
            {pending.length > 0 && (
              <button type="button" className="btn btn-primary btn-sm" onClick={uploadAll} disabled={uploading}>
                {uploading ? "מעלה..." : `העלאת ${pending.length} תמונות`}
              </button>
            )}
          </div>
        </div>

        {pending.length === 0 ? (
          <p className="text-sm text-stone-500">אפשר לבחור תמונה אחת או כמה יחד (JPEG, PNG, GIF או WEBP).</p>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {pending.map((item) => (
              <div key={item.key} className="rounded-2xl border border-cream-300 overflow-hidden bg-white">
                <div className="relative aspect-video bg-cream-100">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.previewUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
                  {item.status === "uploading" && (
                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                      <span className="w-6 h-6 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                    </div>
                  )}
                </div>
                <div className="p-3 space-y-2">
                  <input
                    type="text"
                    placeholder="כותרת (לא חובה)"
                    className="field!"
                    value={item.title}
                    maxLength={120}
                    disabled={item.status === "uploading"}
                    onChange={(e) => updatePending(item.key, { title: e.target.value })}
                  />
                  <textarea
                    placeholder="תיאור קצר (לא חובה)"
                    className="field! min-h-16 resize-none"
                    value={item.description}
                    maxLength={500}
                    disabled={item.status === "uploading"}
                    onChange={(e) => updatePending(item.key, { description: e.target.value })}
                  />
                  {item.status === "error" && <Alert tone="error">{item.error}</Alert>}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-stone-400 truncate max-w-[60%]">{item.file.name}</span>
                    <div className="flex items-center gap-2">
                      {item.status === "error" && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => uploadOne(item)}>
                          ניסיון חוזר
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm text-red-700! hover:bg-red-50!"
                        disabled={item.status === "uploading"}
                        onClick={() => removePending(item.key)}
                      >
                        הסרה
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 className="font-display text-lg font-bold text-stone-900">התמונות בגלריה</h2>
          {reordering && <span className="text-xs text-stone-400">שומר סדר...</span>}
        </div>

        {listError ? (
          <Alert tone="error">{listError}</Alert>
        ) : images === null ? (
          <Loading />
        ) : images.length === 0 ? (
          <EmptyState icon="image">עדיין אין תמונות בגלריה. הוסיפו תמונות למעלה.</EmptyState>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {images.map((image, index) => (
              <div
                key={image.id}
                draggable
                onDragStart={() => onDragStart(index)}
                onDragOver={onDragOver}
                onDrop={() => onDrop(index)}
                className="card overflow-hidden flex flex-col cursor-move"
              >
                <div className="relative aspect-video bg-cream-100">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={image.url} alt={image.title ?? ""} className="absolute inset-0 w-full h-full object-cover" />
                  <span className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/40 text-white flex items-center justify-center">
                    <Icon name="grip" className="w-4 h-4" />
                  </span>
                </div>
                <div className="p-3 flex-1 flex flex-col gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-stone-900 truncate">{image.title || "—"}</p>
                    {image.description && <p className="text-xs text-stone-500 truncate">{image.description}</p>}
                  </div>
                  <div className="mt-auto flex items-center justify-between pt-2 border-t border-cream-100">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-label="הזזה למעלה"
                        className="btn btn-ghost btn-sm p-2!"
                        disabled={index === 0}
                        onClick={() => moveImage(index, -1)}
                      >
                        <Icon name="arrowUp" className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        aria-label="הזזה למטה"
                        className="btn btn-ghost btn-sm p-2!"
                        disabled={index === images.length - 1}
                        onClick={() => moveImage(index, 1)}
                      >
                        <Icon name="arrowDown" className="w-4 h-4" />
                      </button>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm text-red-700! hover:bg-red-50!"
                      onClick={() => removeImage(image)}
                    >
                      מחיקה
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
