/**
 * Paperclip — embedded Paperclip.ing agent orchestration platform.
 * Full iframe embed of the locally-running Paperclip instance.
 */

export default function Paperclip() {
  return (
    <div className="h-full w-full">
      <iframe
        src="https://last-castle.daggertooth-larch.ts.net:10443"
        className="w-full h-full border-0"
        title="Paperclip"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
}
