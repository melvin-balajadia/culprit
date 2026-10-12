import { useState } from "react";
import Traffic from "./Traffic";
import Tester, { type Draft } from "./Tester";

export default function App() {
  const [view, setView] = useState<"traffic" | "tester">("traffic");
  // Each replay gets a new key, so the Tester remounts with the draft as its fresh initial state.
  const [draft, setDraft] = useState<{ key: number; value: Draft }>();

  return (
    <>
      <header className="top">
        <strong className="brand">
          <img src="icons/icon-32.png" width="18" height="18" alt="" />
          Culprit
        </strong>
        <nav>
          <button aria-pressed={view === "traffic"} onClick={() => setView("traffic")}>Traffic</button>
          <button aria-pressed={view === "tester"} onClick={() => setView("tester")}>Tester</button>
        </nav>
      </header>
      {/* Both stay mounted so switching views keeps their state. */}
      <div hidden={view !== "traffic"}>
        <Traffic
          onReplay={(d) => {
            setDraft((prev) => ({ key: (prev?.key ?? 0) + 1, value: d }));
            setView("tester");
          }}
        />
      </div>
      <div hidden={view !== "tester"}>
        <Tester key={draft?.key} draft={draft?.value} />
      </div>
    </>
  );
}
