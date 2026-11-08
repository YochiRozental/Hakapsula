import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // תמונות גלריית הקליניקות מאוחסנות ב-Cloudinary
    remotePatterns: [
      {
        protocol: "https",
        hostname: "res.cloudinary.com",
        pathname: "/**",
      },
    ],
  },
};

export default nextConfig;
