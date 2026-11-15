import { Fragment } from "react";
import { SHORTCUT_LIST } from "../shortcuts.ts";
import { Sheet } from "./Sheet.tsx";

/** The keyboard shortcuts sheet, opened with `?`. */
export default function Shortcuts({ open }: { open: boolean }) {
  return (
    <Sheet open={open} title="Keyboard shortcuts" width={420}>
      <dl className="keys">
        {SHORTCUT_LIST.map((item) => (
          <Fragment key={item.does}>
            <dt>{item.does}</dt>
            <dd>
              {item.keys.map((key, i) => (
                <Fragment key={key}>
                  {i > 0 && item.join ? item.join : null}
                  <kbd className="key">{key}</kbd>
                </Fragment>
              ))}
            </dd>
          </Fragment>
        ))}
      </dl>
    </Sheet>
  );
}
