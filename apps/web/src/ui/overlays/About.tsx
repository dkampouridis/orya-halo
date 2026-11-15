import { Switch } from "@base-ui/react/switch";
import { LAYERS, layerDef } from "@orya-halo/schema";
import type { SourceSummary } from "@orya-halo/schema";
import { useQuery } from "@tanstack/react-query";
import { haloActions, useHalo } from "../../core/store.ts";
import { accentStyle } from "../accents.ts";
import { useServices } from "../hooks.ts";
import { Ring } from "../icons.tsx";
import { setHum, useUi } from "../local.ts";
import { Sheet } from "./Sheet.tsx";

/** Where the project's source and licence notes live, when the deployment says. */
const REPO_URL = (import.meta.env.VITE_REPO_URL as string | undefined)?.replace(/\/+$/, "");

const LAYER_ORDER = new Map(LAYERS.map((l, i) => [l.id, i]));

function External({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function SourceItem({ source }: { source: SourceSummary }) {
  return (
    <li className="source-item" style={accentStyle(source.layer)}>
      <i className="lamp" />
      <div>
        <p className="source-name">
          <span>{source.name}</span>
          <small>{layerDef(source.layer).label}</small>
        </p>
        <p className="source-credit">
          {source.attributionUrl ? (
            <External href={source.attributionUrl}>{source.attribution}</External>
          ) : (
            source.attribution
          )}
        </p>
        <p className="source-meta">
          Licence:{" "}
          {source.licenceUrl ? (
            <External href={source.licenceUrl}>{source.licence}</External>
          ) : (
            source.licence
          )}
        </p>
        {source.notes ? <p className="source-meta">{source.notes}</p> : null}
      </div>
    </li>
  );
}

function Sources() {
  const services = useServices();
  const sources = useQuery({
    queryKey: ["attributions"],
    queryFn: () => (services ? services.getAttributions() : Promise.resolve([] as SourceSummary[])),
    enabled: services !== null,
    staleTime: 5 * 60_000,
    select: (list) =>
      [...list].sort((a, b) => (LAYER_ORDER.get(a.layer) ?? 99) - (LAYER_ORDER.get(b.layer) ?? 99)),
  });
  if (!services || sources.isPending) {
    return (
      <p className="results-note" role="status">
        <Ring /> Loading the list of sources
      </p>
    );
  }
  if (sources.isError) {
    return (
      <div role="status">
        <p>The list of sources could not be loaded.</p>
        <button
          type="button"
          className="btn"
          style={{ marginTop: 10 }}
          onClick={() => void sources.refetch()}
        >
          Try again
        </button>
      </div>
    );
  }
  if (sources.data.length === 0)
    return <p className="dim">No data sources are in use right now.</p>;
  return (
    <ul className="sources">
      {sources.data.map((source) => (
        <SourceItem key={source.id} source={source} />
      ))}
    </ul>
  );
}

function SoundSettings() {
  const sound = useHalo((s) => s.sound);
  const hum = useUi((s) => s.hum);
  return (
    <section className="sheet-section" aria-labelledby="about-sound">
      <h3 id="about-sound">Sound</h3>
      <label className="switch-row">
        <span>
          Sound
          <small>A soft tick when you select something or switch a layer.</small>
        </span>
        <Switch.Root
          className="switch"
          checked={sound}
          onCheckedChange={(on) => haloActions().setSound(on)}
        >
          <Switch.Thumb className="switch-thumb" />
        </Switch.Root>
      </label>
      <label className="switch-row">
        <span>
          Ambient hum
          <small>A low, steady tone underneath. Plays only while sound is on.</small>
        </span>
        <Switch.Root className="switch" checked={hum} disabled={!sound} onCheckedChange={setHum}>
          <Switch.Thumb className="switch-thumb" />
        </Switch.Root>
      </label>
    </section>
  );
}

/** About and attribution: what this is, every source in use, and the credits the base map needs. */
export default function About({ open }: { open: boolean }) {
  return (
    <Sheet
      open={open}
      title="About Orya Halo"
      lede="A live globe of public data: aircraft, ships, satellites, earthquakes and weather, drawn as they report in. Open source, built on open data."
    >
      <section className="sheet-section" aria-labelledby="about-sources">
        <h3 id="about-sources">Data sources</h3>
        <Sources />
      </section>

      <section className="sheet-section" aria-labelledby="about-map">
        <h3 id="about-map">Map, imagery and places</h3>
        <p>
          The base map is <External href="https://protomaps.com">Protomaps</External> tiles built
          from OpenStreetMap data, ©{" "}
          <External href="https://www.openstreetmap.org/copyright">
            OpenStreetMap contributors
          </External>
          , available under the{" "}
          <External href="https://opendatacommons.org/licenses/odbl/1-0/">
            Open Database Licence
          </External>
          .
        </p>
        <p>
          Night lights are NASA's Black Marble 2016: NASA Earth Observatory images by Joshua
          Stevens, using Suomi NPP VIIRS data from Miguel Román, NASA GSFC. NASA does not endorse
          this project.
        </p>
        <p>
          Place names in search © <External href="https://www.geonames.org/">GeoNames</External>,
          under <External href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</External>.
          Aircraft photos come from{" "}
          <External href="https://www.planespotters.net/">Planespotters.net</External>, each
          credited to its photographer beside the photo.
        </p>
      </section>

      <SoundSettings />

      <section className="sheet-section" aria-labelledby="about-licence">
        <h3 id="about-licence">Licences</h3>
        <p>
          Orya Halo's own code is MIT licensed. The base map extract and the undersea cables are
          derived from OpenStreetMap, and aircraft positions from adsb.lol; those three are offered
          under the Open Database Licence instead.
        </p>
        <p>
          Each source's terms, what they allow and when they were last checked are recorded in{" "}
          {REPO_URL ? (
            <External href={`${REPO_URL}/blob/main/docs/DATA_LICENCES.md`}>
              docs/DATA_LICENCES.md
            </External>
          ) : (
            "docs/DATA_LICENCES.md in the project repository"
          )}
          . Interface type is Archivo and Martian Mono, both under the SIL Open Font Licence.
        </p>
      </section>
    </Sheet>
  );
}
