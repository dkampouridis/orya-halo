import { layerDef } from "@orya-halo/schema";
import { useEffect } from "react";
import { useHalo } from "../core/store.ts";
import { positionSpoken } from "./format.ts";
import { announce, useUi } from "./local.ts";

/**
 * The polite live region. Selecting or following an object says its name and
 * where it is; a few actions (copying a link) speak through it too.
 */
export function Announcer() {
  const said = useUi((s) => s.said);

  useEffect(() => {
    // Announce a selection once, when its detail first arrives: that is when there is a name to say.
    let named: string | null = null;
    const offDetail = useHalo.subscribe(
      (s) => s.detail,
      (detail) => {
        const { selection, detailStatus } = useHalo.getState();
        if (!selection) {
          named = null;
          return;
        }
        const id = `${selection.kind}.${selection.id}`;
        if (named === id) return;
        if (detail) {
          named = id;
          const kind = layerDef(detail.layer).noun;
          announce(
            `Selected ${kind} ${detail.title}, at ${positionSpoken(detail.lat, detail.lon)}.`,
          );
        } else if (detailStatus === "missing") {
          named = id;
          announce("That object is no longer in view.");
        }
      },
    );
    const offSelection = useHalo.subscribe(
      (s) => s.selection,
      (selection, previous) => {
        if (!selection) {
          named = null;
          if (previous) announce("Selection cleared.");
        }
      },
    );
    const offFollow = useHalo.subscribe(
      (s) => s.following,
      (following) => {
        const title = useHalo.getState().detail?.title;
        if (following) announce(title ? `Following ${title}.` : "Following.");
        else if (useHalo.getState().selection) announce("Stopped following.");
      },
    );
    return () => {
      offDetail();
      offSelection();
      offFollow();
    };
  }, []);

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {said.text}
      {/* An empty marker on every other message makes a repeated sentence count as a change. */}
      {said.seq % 2 === 1 ? <span /> : null}
    </div>
  );
}
