import type { NextConfig } from "next";

/**
 * Deliberately almost empty.
 *
 * 🇪🇸 NOTA: esta dApp no tiene backend, no lee variables de entorno y no
 * optimiza imágenes propias (los iconos de las wallets llegan como data URI en
 * el anuncio de EIP-6963, así que van en un <img> normal y no por next/image —
 * `next/image` no acepta data URIs sin configurar un loader, y no hay nada que
 * optimizar en un SVG de 700 bytes).
 *
 * Todo lo que hace la página ocurre en el navegador contra `window.codecrypto`.
 * Si algún día aparece configuración aquí, merece una explicación de por qué.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
