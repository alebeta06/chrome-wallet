import { FrameProbe } from "@/components/FrameProbe";

/**
 * A page whose only job is to be embedded in an iframe by `/`.
 *
 * 🇪🇸 NOTA: existe para conservar una comprobación que se perdía al borrar
 * `extension/test.html`. El manifest declara `all_frames: true` y
 * `match_about_blank: true` (spec 34) porque hay dApps que viven dentro de un
 * iframe, y una wallet que solo se inyecta en el frame principal sencillamente
 * no existe para ellas. Sin una página embebida no hay forma de verlo.
 *
 * Es una ruta propia y no un `?frame=1` sobre `/` a posta: leer search params en
 * el App Router obliga a un `<Suspense>` o saca la página del prerender
 * estático. Una ruta aparte es más simple y se prerenderiza igual.
 */
export const metadata = {
  title: "Frame injection probe",
};

export default function FramePage() {
  return <FrameProbe />;
}
