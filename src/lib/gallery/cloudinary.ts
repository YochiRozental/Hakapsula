import crypto from "node:crypto";

type CloudinaryUploadResult = {
  publicId: string;
  url: string;
  width: number | null;
  height: number | null;
};

const GALLERY_FOLDER = "clinics-gallery";

function getConfig() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      "Cloudinary לא מוגדר: חסרים משתני הסביבה CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET",
    );
  }
  return { cloudName, apiKey, apiSecret };
}

/** חתימת Cloudinary: SHA-1 על פרמטרים ממוינים לפי מפתח (key=value&...) עם api_secret בסוף. לעולם לא כולל file/api_key/cloud_name/signature עצמם */
export function signCloudinaryParams(params: Record<string, string | number>, apiSecret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return crypto.createHash("sha1").update(toSign + apiSecret).digest("hex");
}

export async function uploadImageToCloudinary(buffer: Buffer, filename: string): Promise<CloudinaryUploadResult> {
  const { cloudName, apiKey, apiSecret } = getConfig();
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signCloudinaryParams({ folder: GALLERY_FOLDER, timestamp }, apiSecret);

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buffer)]), filename);
  form.append("api_key", apiKey);
  form.append("timestamp", String(timestamp));
  form.append("folder", GALLERY_FOLDER);
  form.append("signature", signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`העלאה ל-Cloudinary נכשלה (${res.status}): ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  return {
    publicId: data.public_id,
    url: data.secure_url,
    width: typeof data.width === "number" ? data.width : null,
    height: typeof data.height === "number" ? data.height : null,
  };
}

/** מחיקה מ-Cloudinary. "not found" נחשבת הצלחה (אידמפוטנטית) כדי לאפשר ניקוי שורות יתומות בבסיס הנתונים */
export async function deleteImageFromCloudinary(publicId: string): Promise<void> {
  const { cloudName, apiKey, apiSecret } = getConfig();
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signCloudinaryParams({ public_id: publicId, timestamp }, apiSecret);

  const form = new FormData();
  form.append("public_id", publicId);
  form.append("api_key", apiKey);
  form.append("timestamp", String(timestamp));
  form.append("signature", signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`מחיקה מ-Cloudinary נכשלה (${res.status}): ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  if (data.result !== "ok" && data.result !== "not found") {
    throw new Error(`מחיקה מ-Cloudinary החזירה תוצאה לא צפויה: ${data.result}`);
  }
}
