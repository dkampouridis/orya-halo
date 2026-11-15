/**
 * State that belongs to the HUD alone and that neither the engine nor the
 * data worker cares about: where the phone sheet stands, the ambient hum
 * preference, the last thing said to screen readers.
 */
import { create } from "zustand";

export type SheetStop = "none" | "peek" | "full";

interface UiState {
  /** Where the phone's detail sheet stands; "none" on wide screens or with nothing selected. */
  sheet: SheetStop;
  /** Play the low ambient hum while sound is on. */
  hum: boolean;
  /** Latest announcement for the polite live region. `seq` makes repeats count as new. */
  said: { text: string; seq: number };
}

const HUM_KEY = "orya-halo.hum";

function readHum(): boolean {
  try {
    return localStorage.getItem(HUM_KEY) === "1";
  } catch {
    return false;
  }
}

export const useUi = create<UiState>()(() => ({
  sheet: "none",
  hum: readHum(),
  said: { text: "", seq: 0 },
}));

export function setSheet(sheet: SheetStop): void {
  if (useUi.getState().sheet !== sheet) useUi.setState({ sheet });
}

export function setHum(hum: boolean): void {
  useUi.setState({ hum });
  try {
    localStorage.setItem(HUM_KEY, hum ? "1" : "0");
  } catch {
    // Private mode: the preference lasts for this visit only.
  }
}

/** Say something through the polite live region. */
export function announce(text: string): void {
  useUi.setState((s) => ({ said: { text, seq: s.said.seq + 1 } }));
}
