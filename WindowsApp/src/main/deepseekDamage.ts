import { handle } from "./ipc";
import {
  DAMAGE_CHANNELS,
  type DamageAnalyzeRequest,
  type DamageAnalyzeResponse,
  type DamageAnalyzeStage,
  type DamageOutline,
  type DamageOutlineRegion,
} from "../shared/damageChannels";
import {
  DEFAULT_COST_DISCLAIMER,
  REPORT_SCHEMA_EXAMPLE,
  computeCostTotals,
  emptyReport,
  normalizeSeverity,
  type WallDamageReport,
} from "../shared/wallDamageReport";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-flash";
const DEFAULT_MAX_IMAGES = 12;

function apiKey(): string {
  const key = (process.env.DEEPSEEK_API_KEY || "").trim();
  if (!key) {
    throw new Error(
      "DeepSeek API key missing. Add DEEPSEEK_API_KEY to WindowsApp/.env (see .env.example).",
    );
  }
  return key;
}

function toDataUrl(input: string): string | null {
  const s = (input || "").trim();
  if (!s) return null;
  if (s.startsWith("data:image/")) return s;
  // Assume jpeg base64 payload
  return `data:image/jpeg;base64,${s.replace(/\s+/g, "")}`;
}

/** Parse the first complete JSON object/array, ignoring trailing junk the model may append. */
function extractBalancedJson(text: string): unknown {
  const startObj = text.indexOf("{");
  const startArr = text.indexOf("[");
  let start = -1;
  let openCh = "{";
  let closeCh = "}";
  if (startObj >= 0 && (startArr < 0 || startObj < startArr)) {
    start = startObj;
  } else if (startArr >= 0) {
    start = startArr;
    openCh = "[";
    closeCh = "]";
  }
  if (start < 0) {
    throw new Error(
      "DeepSeek did not return valid JSON for the damage report.",
    );
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) {
        return JSON.parse(text.slice(start, i + 1));
      }
    }
  }
  throw new Error("DeepSeek did not return valid JSON for the damage report.");
}

function stripTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, "$1");
}

function tryParseJsonText(text: string): unknown | null {
  const candidates = [text, stripTrailingCommas(text)];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // keep trying
    }
  }
  try {
    return extractBalancedJson(text);
  } catch {
    try {
      return extractBalancedJson(stripTrailingCommas(text));
    } catch {
      return null;
    }
  }
}

/**
 * Tolerant JSON extraction — models often change shape, wrap markdown,
 * append commentary, or emit multiple objects. Never require an exact schema.
 */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const direct = tryParseJsonText(trimmed);
  if (direct && typeof direct === "object") return direct;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(trimmed))) {
    const inner = tryParseJsonText(match[1].trim());
    if (inner && typeof inner === "object") return inner;
  }

  // Last resort: scan for every `{...}` and pick the largest object-like blob.
  const blobs: unknown[] = [];
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== "{") continue;
    try {
      const value = extractBalancedJson(trimmed.slice(i));
      if (value && typeof value === "object") blobs.push(value);
    } catch {
      // skip
    }
  }
  if (blobs.length === 0) {
    throw new Error(
      "DeepSeek did not return valid JSON for the damage report.",
    );
  }
  blobs.sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length);
  return blobs[0];
}

function asString(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return fallback;
}

function asNumber(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[,$]/g, "").trim());
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asBool(v: unknown, fallback = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "yes", "1", "y"].includes(s)) return true;
    if (["false", "no", "0", "n"].includes(s)) return false;
  }
  if (typeof v === "number") return v !== 0;
  return fallback;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** First present object among alternate model key names. */
function pickRecord(
  obj: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  for (const key of keys) {
    const hit = asRecord(obj[key]);
    if (Object.keys(hit).length > 0) return hit;
  }
  // Case-insensitive fallback for drifting keys.
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const key of keys) {
    const real = lower.get(key.toLowerCase());
    if (!real) continue;
    const hit = asRecord(obj[real]);
    if (Object.keys(hit).length > 0) return hit;
  }
  return {};
}

function pickValue(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "")
      return obj[key];
  }
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const key of keys) {
    const real = lower.get(key.toLowerCase());
    if (!real) continue;
    if (obj[real] !== undefined && obj[real] !== null && obj[real] !== "")
      return obj[real];
  }
  return undefined;
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  if (typeof v === "string" && v.trim()) return [v];
  if (typeof v === "object") return [v];
  return [];
}

/** Shown to the user whenever the model output can't be turned into a real report. */
const INCOMPLETE_ANALYSIS =
  "The damage analysis came back incomplete, so no estimate was produced. Try marking the area again.";

function mapSymptoms(list: unknown[]): WallDamageReport["damage_assessment"]["visible_symptoms"] {
  return list
    .map((item) => {
      if (typeof item === "string") {
        return { type: item, location: "", description: "" };
      }
      const s = asRecord(item);
      return {
        type: asString(pickValue(s, ["type", "name", "symptom", "title"])),
        location: asString(pickValue(s, ["location", "where", "position"])),
        description: asString(
          pickValue(s, ["description", "details", "note", "text"]),
        ),
      };
    })
    .filter((s) => s.type || s.description);
}

/** "$200 - $400", "200–400", "$1,200", 350 → { min, max } (NaN when unreadable). */
function parseMoneyRange(v: unknown): { min: number; max: number } {
  if (typeof v === "number" && Number.isFinite(v)) return { min: v, max: v };
  if (typeof v !== "string") return { min: Number.NaN, max: Number.NaN };
  const nums = (v.replace(/,/g, "").match(/\d+(?:\.\d+)?/g) || [])
    .map(Number)
    .filter((n) => Number.isFinite(n));
  if (nums.length === 0) return { min: Number.NaN, max: Number.NaN };
  return { min: Math.min(...nums.slice(0, 2)), max: Math.max(...nums.slice(0, 2)) };
}

function looksPerSqft(v: unknown): boolean {
  return typeof v === "string" && /(sq\.?\s*_?f|sqft|square\s*f|ft²|ft2)/i.test(v);
}

/** Line items in any shape the model uses → priced rows (blank / unpriced rows dropped). */
function mapLineItems(raw: unknown): WallDamageReport["cost_breakdown_estimate"]["line_items"] {
  return asArray(raw)
    .map((entry) => {
      const row = asRecord(entry);
      let min = parseMoneyRange(
        pickValue(row, ["min_cost", "minCost", "min", "low", "cost_min"]),
      ).min;
      let max = parseMoneyRange(
        pickValue(row, ["max_cost", "maxCost", "max", "high", "cost_max"]),
      ).max;
      const rangeRaw = pickValue(row, [
        "cost_range", "costRange", "range", "estimated_cost", "estimatedCost",
        "price", "price_range", "cost", "amount", "total",
      ]);
      const range = parseMoneyRange(rangeRaw);
      if (!Number.isFinite(min) && Number.isFinite(range.min)) min = range.min;
      if (!Number.isFinite(max) && Number.isFinite(range.max)) max = range.max;
      if (!Number.isFinite(min)) min = Number.isFinite(max) ? max : 0;
      if (!Number.isFinite(max)) max = min;
      let unit = asString(pickValue(row, ["unit", "pricing_unit", "basis"]));
      if (!unit && looksPerSqft(rangeRaw)) unit = "per_sqft";
      return {
        item: asString(pickValue(row, ["item", "name", "title", "label", "task", "description"])),
        min_cost: min,
        max_cost: max,
        unit,
        notes: asString(pickValue(row, ["notes", "note", "details"])),
      };
    })
    .filter((row) => row.item && (row.min_cost > 0 || row.max_cost > 0));
}

/**
 * Map whatever JSON shape the model returns onto our stable report type.
 * Starts from an EMPTY report — nothing here invents severity, symptoms or prices.
 */
function mergeReport(partial: unknown): WallDamageReport {
  const base = emptyReport();
  if (!partial || typeof partial !== "object") return base;
  const p = asRecord(partial);

  const meta = pickRecord(p, [
    "report_metadata",
    "reportMetadata",
    "metadata",
    "meta",
    "report",
  ]);
  const loc = pickRecord(meta, ["location", "site", "address"]);
  base.report_metadata = {
    report_id: `WR-${Date.now()}`,
    inspection_date: new Date().toISOString().slice(0, 10),
    inspector_name: "Vroomk Damage Estimation",
    location: {
      state: asString(pickValue(loc, ["state", "region"])),
      country: asString(pickValue(loc, ["country"])),
      room: asString(pickValue(loc, ["room", "area", "space"])),
      wall_orientation: asString(
        pickValue(loc, ["wall_orientation", "wallOrientation", "wall", "orientation"]),
      ),
    },
  };

  const da = pickRecord(p, [
    "damage_assessment",
    "damageAssessment",
    "assessment",
    "damage",
  ]);
  const area = pickRecord(da, [
    "damaged_area_estimation",
    "damagedAreaEstimation",
    "area",
    "area_estimation",
    "areaEstimation",
  ]);
  base.damage_assessment = {
    severity_level: normalizeSeverity(
      asString(pickValue(da, ["severity_level", "severityLevel", "severity"])),
    ),
    damaged_area_estimation: {
      unit: "square_feet",
      estimated_total_area_sqft: Math.max(
        0,
        asNumber(
          pickValue(area, [
            "estimated_total_area_sqft",
            "estimatedTotalAreaSqft",
            "area_sqft",
            "areaSqft",
            "sqft",
            "square_feet",
            "total_area",
          ]),
          0,
        ),
      ),
      affected_zone: asString(
        pickValue(area, ["affected_zone", "affectedZone", "zone", "location"]),
      ),
      area_source: "estimated",
    },
    visible_symptoms: mapSymptoms(
      asArray(
        pickValue(da, ["visible_symptoms", "visibleSymptoms", "symptoms", "findings"]),
      ),
    ),
  };

  const ca = pickRecord(p, ["cause_analysis", "causeAnalysis", "cause", "causes"]);
  base.cause_analysis = {
    primary_cause_suspected: asString(
      pickValue(ca, [
        "primary_cause_suspected",
        "primaryCauseSuspected",
        "primary_cause",
        "primaryCause",
        "cause",
      ]),
    ),
    possible_sources: asArray(
      pickValue(ca, ["possible_sources", "possibleSources", "sources", "likely_causes"]),
    )
      .map((item) => {
        if (typeof item === "string") {
          return { source: item, probability: "", description: "" };
        }
        const s = asRecord(item);
        return {
          source: asString(pickValue(s, ["source", "name", "cause", "title"])),
          probability: asString(
            pickValue(s, ["probability", "likelihood", "confidence"]),
          ),
          description: asString(
            pickValue(s, ["description", "details", "note", "text"]),
          ),
        };
      })
      .filter((s) => s.source || s.description),
    requires_professional_detection: asBool(
      pickValue(ca, [
        "requires_professional_detection",
        "requiresProfessionalDetection",
        "professional_detection",
        "needs_pro",
      ]),
      false,
    ),
  };

  const rp = pickRecord(p, ["repair_plan", "repairPlan", "repairs", "repair"]);
  base.repair_plan = {
    prerequisite_action: asString(
      pickValue(rp, ["prerequisite_action", "prerequisiteAction", "first", "prerequisite"]),
    ),
    steps: asArray(pickValue(rp, ["steps", "actions", "plan"]))
      .map((s) => asString(s))
      .filter(Boolean),
  };

  const cost = pickRecord(p, [
    "cost_breakdown_estimate",
    "costBreakdownEstimate",
    "cost_estimate",
    "costEstimate",
    "costs",
    "pricing",
  ]);
  base.cost_breakdown_estimate.line_items = mapLineItems(
    pickValue(cost, ["line_items", "lineItems", "items", "breakdown"]) ??
      pickValue(p, ["line_items", "lineItems", "cost_items", "costItems"]),
  );
  base.cost_breakdown_estimate.currency = "USD";
  base.cost_breakdown_estimate.market_region = asString(
    pickValue(cost, ["market_region", "marketRegion", "market", "region"]),
    "USA (Approximate)",
  );
  const total = pickRecord(cost, [
    "total_estimated_cost_range",
    "totalEstimatedCostRange",
    "total",
    "total_range",
    "totalRange",
  ]);
  base.cost_breakdown_estimate.total_estimated_cost_range = {
    // Real totals are computed in computeCostTotals — never trusted from the model.
    min_total: 0,
    max_total: 0,
    disclaimer: asString(
      pickValue(total, ["disclaimer", "note", "notes"]),
      DEFAULT_COST_DISCLAIMER,
    ),
  };

  const rec = pickRecord(p, ["recommendations", "recommendation", "next_steps", "nextSteps"]);
  base.recommendations.immediate_actions = asArray(
    pickValue(rec, ["immediate_actions", "immediateActions", "actions", "items"]),
  )
    .map((a) => asString(a))
    .filter(Boolean);

  return base;
}

/** A report with no severity, no symptoms and no costs is not a report. */
/** Usable = the model actually assessed something (a severity, an issue, or a price). */
function isUsableReport(report: WallDamageReport): boolean {
  const hasSeverity = Boolean(report.damage_assessment.severity_level.trim());
  const hasSymptoms = report.damage_assessment.visible_symptoms.length > 0;
  const hasCosts = report.cost_breakdown_estimate.line_items.length > 0;
  return hasSeverity || hasSymptoms || hasCosts;
}

const REPORT_SECTION_KEYS = [
  "damage_assessment", "damageAssessment", "assessment",
  "cost_breakdown_estimate", "costBreakdownEstimate", "cause_analysis", "causeAnalysis",
];

/**
 * Models sometimes wrap the report — {"report": {...}, "best_image_index": 1} or
 * {"wall_damage_report": {...}}. Find the object that holds the report sections and
 * keep root-level fields (image indices) alongside it.
 */
function unwrapReportRoot(value: unknown, depth = 0): Record<string, unknown> {
  const root = asRecord(value);
  const lowerKeys = Object.keys(root).map((k) => k.toLowerCase());
  if (REPORT_SECTION_KEYS.some((k) => lowerKeys.includes(k.toLowerCase()))) return root;
  if (depth >= 3) return root;
  for (const child of Object.values(root)) {
    const candidate = Array.isArray(child) ? child[0] : child;
    if (!candidate || typeof candidate !== "object") continue;
    const inner = unwrapReportRoot(candidate, depth + 1);
    const innerKeys = Object.keys(inner).map((k) => k.toLowerCase());
    if (REPORT_SECTION_KEYS.some((k) => innerKeys.includes(k.toLowerCase()))) {
      return { ...root, ...inner };
    }
  }
  return root;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function parseSymptomIndices(r: Record<string, unknown>, symptomCount: number): number[] {
  const raw = pickValue(r, ["symptom_indices", "symptomIndices", "symptom_index", "symptomIndex"]);
  return asArray(raw)
    .map((v) => Math.floor(asNumber(v, Number.NaN)))
    .filter((n) => Number.isFinite(n) && n >= 0 && n < symptomCount)
    .filter((n, i, all) => all.indexOf(n) === i);
}

type RawRegion = {
  label: string;
  symptomIndices: number[];
  /** x, y, w, h in the model's own coordinate units. */
  box: [number, number, number, number] | null;
  polygon: Array<[number, number]> | null;
};

/**
 * Work out what units the model used for coordinates and return x/y divisors.
 * Asked for 0–1, but models also answer in pixels or on a 0–1000 grid; without this
 * every outline gets clamped to the image edge and silently dropped.
 */
function coordinateDivisors(
  regions: RawRegion[],
  size?: { width: number; height: number },
): { sx: number; sy: number } {
  // Positions (box origins, polygon points) decide the units. Box extents are only a
  // tie-breaker: a normalized box often runs a little past the edge (x 0.6 + w 0.5).
  let posMax = 0;
  let maxX = 0;
  let maxY = 0;
  for (const r of regions) {
    if (r.box) {
      posMax = Math.max(posMax, Math.abs(r.box[0]), Math.abs(r.box[1]), Math.abs(r.box[2]), Math.abs(r.box[3]));
      maxX = Math.max(maxX, r.box[0] + r.box[2]);
      maxY = Math.max(maxY, r.box[1] + r.box[3]);
    }
    for (const [x, y] of r.polygon || []) {
      posMax = Math.max(posMax, Math.abs(x), Math.abs(y));
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (posMax <= 1.05) return { sx: 1, sy: 1 };
  if (size && maxX <= size.width * 1.03 && maxY <= size.height * 1.03 && (maxX > 1000 || maxY > 1000 || size.width < 980 || size.height < 980)) {
    return { sx: size.width, sy: size.height };
  }
  if (maxX <= 1000 && maxY <= 1000) return { sx: 1000, sy: 1000 };
  if (size) return { sx: size.width, sy: size.height };
  return { sx: Math.max(maxX, 1), sy: Math.max(maxY, 1) };
}

function parseOutline(
  partial: unknown,
  imageCount: number,
  symptomCount: number,
  size?: { width: number; height: number },
): DamageOutline | null {
  if (!partial || typeof partial !== "object") return null;
  const root = asRecord(partial);
  const raw = pickRecord(root, [
    "damage_outline",
    "damageOutline",
    "outline",
    "outlines",
    "regions_outline",
  ]);
  // Some models return regions at the top level.
  const list = asArray(
    pickValue(Object.keys(raw).length ? raw : root, [
      "regions",
      "boxes",
      "polygons",
      "damage_regions",
      "damageRegions",
      "detections",
      "objects",
    ]),
  );
  if (list.length === 0) return null;

  const imageIndex = Math.max(
    0,
    Math.min(
      asNumber(
        pickValue(raw, ["image_index", "imageIndex", "index"]) ??
          pickValue(root, ["best_image_index", "bestImageIndex"]),
        0,
      ),
      Math.max(0, imageCount - 1),
    ),
  );

  // 1) Read raw numbers in whatever units the model used.
  const rawRegions: RawRegion[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = asRecord(item);
    let box: RawRegion["box"] = null;

    const boxRaw = pickRecord(r, ["box", "bbox", "bounds", "rect", "bounding_box", "boundingBox"]);
    const x1 = asNumber(pickValue(boxRaw, ["x1", "xmin", "x_min", "left"]), Number.NaN);
    const y1 = asNumber(pickValue(boxRaw, ["y1", "ymin", "y_min", "top"]), Number.NaN);
    const x2 = asNumber(pickValue(boxRaw, ["x2", "xmax", "x_max", "right"]), Number.NaN);
    const y2 = asNumber(pickValue(boxRaw, ["y2", "ymax", "y_max", "bottom"]), Number.NaN);
    const bx = asNumber(pickValue(boxRaw, ["x"]), Number.NaN);
    const by = asNumber(pickValue(boxRaw, ["y"]), Number.NaN);
    const bw = asNumber(pickValue(boxRaw, ["w", "width"]), Number.NaN);
    const bh = asNumber(pickValue(boxRaw, ["h", "height"]), Number.NaN);
    if ([x1, y1, x2, y2].every(Number.isFinite) && x2 > x1 && y2 > y1) {
      box = [x1, y1, x2 - x1, y2 - y1];
    } else if ([bx, by, bw, bh].every(Number.isFinite)) {
      box = [bx, by, bw, bh];
    } else if ([x1, y1, bw, bh].every(Number.isFinite)) {
      box = [x1, y1, bw, bh];
    }

    const boxArr = pickValue(r, ["box", "bbox", "bounding_box", "boundingBox"]);
    if (!box && Array.isArray(boxArr) && boxArr.length >= 4) {
      const [a, b, c, d] = boxArr.slice(0, 4).map((v) => asNumber(v, Number.NaN));
      if ([a, b, c, d].every(Number.isFinite)) {
        // [x1, y1, x2, y2] when the 3rd/4th values only make sense as corners.
        const corners = c > a && d > b && (c + a > Math.max(1.05, c) || d + b > Math.max(1.05, d));
        box = corners ? [a, b, c - a, d - b] : [a, b, c, d];
      }
    }

    const polyRaw = asArray(pickValue(r, ["polygon", "points", "path", "coords", "vertices"]));
    const polygon =
      polyRaw.length >= 3
        ? polyRaw
            .map((pt) => {
              if (Array.isArray(pt) && pt.length >= 2) {
                return [asNumber(pt[0], Number.NaN), asNumber(pt[1], Number.NaN)] as [number, number];
              }
              const o = asRecord(pt);
              return [asNumber(o.x, Number.NaN), asNumber(o.y, Number.NaN)] as [number, number];
            })
            .filter((pt) => Number.isFinite(pt[0]) && Number.isFinite(pt[1]))
        : [];

    rawRegions.push({
      label: asString(pickValue(r, ["label", "type", "name", "title"]), "Damage"),
      symptomIndices: parseSymptomIndices(r, symptomCount),
      box,
      polygon: polygon.length >= 3 ? polygon : null,
    });
  }

  // 2) Convert to 0–1 using the detected units.
  const { sx, sy } = coordinateDivisors(rawRegions, size);
  const regions: DamageOutlineRegion[] = [];
  for (const rr of rawRegions) {
    const polygon = rr.polygon
      ? rr.polygon.map(([x, y]) => [clamp01(x / sx), clamp01(y / sy)] as [number, number])
      : undefined;
    let x: number;
    let y: number;
    let w: number;
    let h: number;
    if (rr.box) {
      x = rr.box[0] / sx;
      y = rr.box[1] / sy;
      w = rr.box[2] / sx;
      h = rr.box[3] / sy;
    } else if (polygon && polygon.length >= 3) {
      const xs = polygon.map((p) => p[0]);
      const ys = polygon.map((p) => p[1]);
      x = Math.min(...xs);
      y = Math.min(...ys);
      w = Math.max(...xs) - x;
      h = Math.max(...ys) - y;
    } else {
      continue;
    }
    if (![x, y, w, h].every(Number.isFinite)) continue;
    const cx = clamp01(x);
    const cy = clamp01(y);
    const cw = Math.min(1 - cx, Math.max(0, w));
    const ch = Math.min(1 - cy, Math.max(0, h));
    if (cw <= 0.01 || ch <= 0.01) continue;
    regions.push({
      label: rr.label,
      box: { x: cx, y: cy, w: cw, h: ch },
      polygon: polygon && polygon.length >= 3 ? polygon : undefined,
      symptomIndices: rr.symptomIndices.length ? rr.symptomIndices : undefined,
    });
  }

  if (regions.length === 0) return null;
  return { imageIndex, regions };
}

function parseBestImageIndex(partial: unknown, imageCount: number): number {
  if (!partial || typeof partial !== "object") return 0;
  const root = partial as Record<string, unknown>;
  const direct = asNumber(
    root.best_image_index ?? root.bestImageIndex ?? root.outline_image_index,
    Number.NaN,
  );
  if (Number.isFinite(direct)) {
    return Math.max(0, Math.min(Math.floor(direct), imageCount - 1));
  }
  const outline = (root.damage_outline ?? {}) as Record<string, unknown>;
  const fromOutline = asNumber(outline.image_index, Number.NaN);
  if (Number.isFinite(fromOutline)) {
    return Math.max(0, Math.min(Math.floor(fromOutline), imageCount - 1));
  }
  return 0;
}

/** Photos needed to outline every issue — usually just [best]; extras only when required. */
function parseOutlineImageIndices(partial: unknown, imageCount: number): number[] {
  const best = parseBestImageIndex(partial, imageCount);
  if (!partial || typeof partial !== "object") return [best];
  const root = asRecord(partial);
  const raw = pickValue(root, [
    "outline_image_indices",
    "outlineImageIndices",
    "outline_images",
    "images_for_outline",
  ]);
  const fromList = asArray(raw)
    .map((v) => asNumber(v, Number.NaN))
    .filter((n) => Number.isFinite(n))
    .map((n) => Math.max(0, Math.min(Math.floor(n), imageCount - 1)));

  const unique: number[] = [];
  for (const idx of [best, ...fromList]) {
    if (!unique.includes(idx)) unique.push(idx);
  }
  // Hard cap — never outline every photo by default.
  return unique.slice(0, 3);
}

/** Words too generic to prove a region and a symptom are the same thing. */
const GENERIC_WORDS = new Set([
  "wall", "walls", "damage", "damaged", "area", "areas", "surface", "visible",
  "minor", "major", "small", "large", "some", "near", "with", "from", "the", "and",
]);

function meaningfulWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w))
    // crude singular form so "cracks" matches "crack"
    .map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w));
}

/** Fallback when the model didn't tag symptom indices: share a meaningful word. */
function labelMatchesSymptom(label: string, symptomType: string): boolean {
  const a = meaningfulWords(label);
  const b = meaningfulWords(symptomType);
  if (a.length === 0 || b.length === 0) return false;
  return a.some((w) => b.includes(w));
}

/** Indices of reported symptoms that no outline region covers yet. */
function uncoveredSymptomIndices(
  report: WallDamageReport,
  regions: DamageOutlineRegion[],
): number[] {
  const symptoms = report.damage_assessment.visible_symptoms;
  const missing: number[] = [];
  symptoms.forEach((symptom, index) => {
    const covered = regions.some(
      (r) =>
        r.symptomIndices?.includes(index) ||
        (!r.symptomIndices?.length && labelMatchesSymptom(r.label, symptom.type)),
    );
    if (!covered) missing.push(index);
  });
  return missing;
}

function scalePromptBlock(measureFactor?: number, measuredAreaSqft?: number): string {
  const factor =
    typeof measureFactor === "number" && Number.isFinite(measureFactor) && measureFactor > 0
      ? measureFactor
      : null;
  const area =
    typeof measuredAreaSqft === "number" && Number.isFinite(measuredAreaSqft) && measuredAreaSqft > 0
      ? measuredAreaSqft
      : null;
  if (factor && area) {
    return [
      "MEASURED AREA (from the calibrated 3D scan — authoritative):",
      `- The user-marked damage outline measures ${area.toFixed(1)} sq ft on the wall.`,
      `- Set estimated_total_area_sqft to ${area.toFixed(1)} unless the visible damage clearly covers only part of the outline.`,
      "- Size every per_sqft line item for this area. Do NOT guess absolute size from the photos.",
    ].join("\n");
  }
  return [
    "Scale: this project has no calibrated measurement, so real-world size is unknown.",
    "- Estimate estimated_total_area_sqft cautiously from visual cues (outlets, doors, trim are useful references).",
    "- Mention the size uncertainty in affected_zone.",
  ].join("\n");
}

function markedRegionGuidePrompt(
  hasGuideImage: boolean,
  photosMasked: boolean,
  hasScope: boolean,
): string {
  const lines = ["USER-MARKED REGION (REQUIRED SCOPE — this is the most important rule):"];
  if (hasScope) {
    lines.push(
      "- Image SCOPE (sent first) is a crop of the 3D scan showing EXACTLY the area the user marked: the bright area inside the ORANGE DASHED border. Everything darkened is OUT OF SCOPE.",
      "- Report ONLY damage you can actually see inside the bright SCOPE area.",
      "- The photos (Image 0…) were taken near this spot but usually ALSO show walls, ceilings, seams and corners OUTSIDE the marked area.",
      "- Use the photos only to see more detail of things that are ALSO visible inside the SCOPE area. Ignore anything in a photo that you cannot match to the SCOPE area.",
      "- If the SCOPE area shows no damage, report no damage — even if the photos show damage elsewhere.",
      "- best_image_index / outline_image_indices: pick photos that show the SAME wall area as SCOPE (they are shown to the user as close-ups). Never pick a photo of a different area.",
    );
  }
  if (photosMasked) {
    lines.push(
      "- On each analysis photo the marked region is the BRIGHT area inside the ORANGE DASHED border; everything outside it has been darkened.",
      "- Only assess damage inside that bright area. Ignore anything in the darkened part.",
    );
  }
  if (hasGuideImage && !hasScope) {
    lines.push(
      "- Image GUIDE (sent first) is a SCREENSHOT of the 3D viewer with an ORANGE polygon / pins showing the marked region.",
      "- The GUIDE is NOT an analysis photo — use it only to understand which wall region is in scope.",
    );
    if (!photosMasked) {
      lines.push("- Mentally map the orange marked wall region onto each photo; ignore damage outside it.");
    }
  }
  lines.push(
    "- Do NOT invent or report damage outside the marked area.",
    "- DO include EVERY distinct damage clearly inside the marked area.",
  );
  return lines.join("\n");
}

function buildPassAPrompt(opts: {
  projectName?: string;
  imageCount: number;
  measureFactor?: number;
  measuredAreaSqft?: number;
  hasGuideImage: boolean;
  photosMasked: boolean;
  hasScope: boolean;
}): string {
  const { imageCount } = opts;
  return [
    "You are a wall damage assessment expert for USA residential / light commercial properties.",
    opts.hasScope
      ? `You will receive 1 SCOPE image + ${imageCount} nearby photo(s) (Image 0 … Image ${imageCount - 1}).`
      : opts.hasGuideImage
        ? `You will receive 1 GUIDE screenshot + ${imageCount} photo(s) (Image 0 … Image ${imageCount - 1}).`
        : `You will receive ${imageCount} photo(s) of a wall / nearby surface (Image 0 … Image ${imageCount - 1}).`,
    "PASS A — classify damage and pick the best photo for outlining. Do NOT return polygons.",
    opts.projectName ? `Project context name: ${opts.projectName}` : "",
    scalePromptBlock(opts.measureFactor, opts.measuredAreaSqft),
    markedRegionGuidePrompt(opts.hasGuideImage, opts.photosMasked, opts.hasScope),
    "Return ONLY a single JSON object (no markdown, no commentary) with:",
    "1) The report schema below (values shown are placeholders — replace them all)",
    "2) best_image_index: 0-based index of the photo that shows the in-region damage most clearly",
    "3) outline_image_indices: photos needed to outline EVERY distinct issue inside the mark",
    "   - Usually just [best_image_index]",
    "   - Add extra indices ONLY when some in-region issues are NOT visible on the best photo",
    JSON.stringify(
      { ...REPORT_SCHEMA_EXAMPLE, best_image_index: 0, outline_image_indices: [0] },
      null,
      2,
    ),
    "Rules:",
    "- severity_level must ALWAYS be exactly Low, Moderate, or High — never empty, N/A or None. Unfinished or cosmetic work is Low or Moderate.",
    "- visible_symptoms: one entry per distinct issue, with a short type name (e.g. \"crack\", \"water stain\", \"hole\", \"peeling paint\").",
    "- line_items must match the damage you actually see (a crack does not need mold treatment; a stain may not need drywall replacement).",
    "- Each line item: unit \"\" for a flat job price, or \"per_sqft\" for a rate per square foot (the app multiplies by area). No other units.",
    "- Use realistic current USA contractor rates in USD. min_cost ≤ max_cost.",
    "- Do not compute totals — the app sums line items itself.",
    "- Set requires_professional_detection true if mold, active leak, electrical, or structural risk is suspected.",
    "- Prefer concrete repair steps.",
    `- best_image_index MUST be an integer from 0 to ${imageCount - 1}.`,
    `- outline_image_indices: 1–3 unique ints from 0..${imageCount - 1}; prefer ONE photo when possible.`,
    "- Prefer a photo where the damage is large, sharp, frontal, and not heavily occluded.",
    "- line_items are REQUIRED whenever visible_symptoms is not empty. Price everything needed to bring the marked area to a finished, repaired condition — including unfinished / incomplete work (e.g. unfinished drywall, missing tape & mud, missing paint), not only sudden damage.",
    "- Every line item needs numeric min_cost and max_cost (no strings, no zeros).",
    "- Only if the marked area is fully finished and undamaged: severity_level Low, visible_symptoms and line_items empty, and say so in affected_zone.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildPassBPrompt(hints: {
  severity?: string;
  symptoms: string[];
  mustCover?: number[];
  hasGuideImage: boolean;
  photoMasked: boolean;
  /** Outlining on the SCOPE crop itself. */
  onScope?: boolean;
  imageSize?: { width: number; height: number };
}): string {
  const numbered = hints.symptoms.map((s, i) => `  ${i}: ${s}`).join("\n");
  return [
    "You are a wall damage localization expert.",
    hints.onScope
      ? "PASS B — You receive ONE image: a crop of a 3D scan. The marked area is the BRIGHT region inside the ORANGE DASHED border; the darkened part is out of scope. Outline damage ONLY inside the bright region."
      : hints.hasGuideImage
      ? "PASS B — You receive Image GUIDE (3D mark screenshot) + ONE analysis photo (the LAST image). Outline damage on the analysis photo only."
      : "PASS B — You receive ONE analysis photo. Draw TIGHT outlines around every visibly damaged area inside the marked region.",
    hints.onScope
      ? "Every polygon point must lie inside the orange dashed border. Never outline anything in the darkened area."
      : hints.photoMasked
      ? "The marked region is the BRIGHT area inside the ORANGE DASHED border on the analysis photo. Outline only inside it."
      : hints.hasGuideImage
        ? "Use the GUIDE only to know WHICH wall area is in scope."
        : "Stay inside the user-marked wall area.",
    hints.severity ? `Prior severity assessment: ${hints.severity}.` : "",
    numbered ? `Reported symptoms (index: description):\n${numbered}` : "",
    hints.mustCover?.length
      ? `PRIORITY — symptoms ${hints.mustCover.join(", ")} are not outlined yet; outline them if visible.`
      : "",
    "Return ONLY a single JSON object (no markdown, no commentary):",
    JSON.stringify(
      {
        damage_outline: {
          image_index: 0,
          regions: [
            {
              label: "water stain",
              symptom_indices: [0],
              box: { x: 0.2, y: 0.25, w: 0.35, h: 0.4 },
              polygon: [
                [0.22, 0.28],
                [0.52, 0.27],
                [0.55, 0.62],
                [0.24, 0.6],
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
    "Rules:",
    "- damage_outline.image_index must be 0 (this single analysis image).",
    "- One region per distinct damaged area INSIDE the marked region.",
    "- symptom_indices: which reported symptom index/indices each region shows (from the list above).",
    "- Do NOT outline anything outside the marked region.",
    hints.imageSize
      ? `- The image is ${hints.imageSize.width}×${hints.imageSize.height} px. Coordinates are NORMALIZED 0–1 (x / ${hints.imageSize.width}, y / ${hints.imageSize.height}; x right, y down).`
      : "- Coordinates are NORMALIZED 0–1 (x right, y down) relative to the ANALYSIS photo.",
    "- Outline EVERY reported symptom that is visible; one region per distinct area.",
    "- Prefer a tight polygon hugging the damage edge (6–20 points). Also include box {x,y,w,h}.",
    "- Do not outline plastic sheeting, tape, furniture, the orange border itself, or undamaged wall.",
    "- If no in-region damage is visible, return regions: [].",
  ]
    .filter(Boolean)
    .join("\n");
}

async function callDeepSeekJson(
  key: string,
  content: Array<Record<string, unknown>>,
  temperature = 0.2,
  label = "request",
): Promise<unknown> {
  const response = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [{ role: "user", content }],
      temperature,
      response_format: { type: "json_object" },
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`DeepSeek error (${response.status}): ${text.slice(0, 240)}`);
  }

  let decoded: {
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: string; reasoning_content?: string };
    }>;
  };
  try {
    decoded = JSON.parse(text) as typeof decoded;
  } catch {
    console.warn(`[damage] ${label}: response was not JSON:`, text.slice(0, 600));
    throw new Error("Could not decode DeepSeek response.");
  }

  const choice = decoded.choices?.[0];
  const finish = choice?.finish_reason ?? "?";
  const message = choice?.message?.content?.trim() || "";
  const reasoning = choice?.message?.reasoning_content?.trim() || "";
  if (finish === "length") {
    console.warn(`[damage] ${label}: model output was cut off (finish_reason=length).`);
  }
  // Thinking models sometimes leave content empty and put the JSON in reasoning.
  for (const candidate of [message, reasoning]) {
    if (!candidate) continue;
    try {
      return extractJsonObject(candidate);
    } catch {
      // try next
    }
  }
  console.warn(
    `[damage] ${label}: no usable JSON (finish_reason=${finish}, content ${message.length} chars, reasoning ${reasoning.length} chars). Start of content:`,
    (message || reasoning).slice(0, 800),
  );
  if (!message && !reasoning) throw new Error("DeepSeek returned an empty analysis.");
  throw new Error("DeepSeek did not return valid JSON for the damage report.");
}

/** Text-only follow-up that prices the already-identified issues. */
async function runCostPass(
  key: string,
  report: WallDamageReport,
): Promise<WallDamageReport["cost_breakdown_estimate"]["line_items"]> {
  const area = report.damage_assessment.damaged_area_estimation;
  const prompt = [
    "You are a USA residential repair cost estimator.",
    "Price the work needed to bring this wall area to a finished, repaired condition.",
    `Area: ${area.estimated_total_area_sqft > 0 ? `${area.estimated_total_area_sqft} sq ft (${area.area_source === "measured" ? "measured" : "estimated"})` : "unknown"}.`,
    `Severity: ${report.damage_assessment.severity_level || "unknown"}.`,
    "Issues:",
    ...report.damage_assessment.visible_symptoms.map(
      (s) => `- ${[s.type, s.location, s.description].filter(Boolean).join(" — ")}`,
    ),
    report.cause_analysis.primary_cause_suspected
      ? `Cause: ${report.cause_analysis.primary_cause_suspected}`
      : "",
    report.repair_plan.steps.length
      ? `Planned repair steps:\n${report.repair_plan.steps.map((s) => `- ${s}`).join("\n")}`
      : "",
    "Return ONLY a JSON object:",
    JSON.stringify({
      line_items: [
        { item: "<repair item>", min_cost: 0, max_cost: 0, unit: "", notes: "" },
        { item: "<area-priced item>", min_cost: 0, max_cost: 0, unit: "per_sqft", notes: "" },
      ],
    }),
    "Rules: 2–6 items; numeric min_cost ≤ max_cost in USD; unit \"\" = flat job price, \"per_sqft\" = rate per square foot; realistic current USA contractor rates; include labor and materials.",
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const out = await callDeepSeekJson(key, [{ type: "text", text: prompt }], 0.2, "cost pass");
    const root = asRecord(out);
    const cost = pickRecord(root, ["cost_breakdown_estimate", "costBreakdownEstimate", "costs"]);
    return mapLineItems(
      pickValue(root, ["line_items", "lineItems", "items"]) ??
        pickValue(cost, ["line_items", "lineItems", "items"]),
    );
  } catch {
    return [];
  }
}

export async function analyzeWallDamage(
  request: DamageAnalyzeRequest,
  onProgress?: (stage: DamageAnalyzeStage) => void,
): Promise<DamageAnalyzeResponse> {
  const key = apiKey();
  const maxImages = Math.max(
    1,
    Math.min(request.maxImages ?? DEFAULT_MAX_IMAGES, DEFAULT_MAX_IMAGES),
  );
  const images = (request.imageDataUrls || [])
    .map(toDataUrl)
    .filter((url): url is string => Boolean(url))
    .slice(0, maxImages);

  if (images.length === 0) {
    throw new Error("No images available for damage analysis.");
  }

  const scopeUrl = toDataUrl(request.scopeImageDataUrl || "");
  const hasScope = Boolean(scopeUrl);
  // The exact scope crop replaces the old orange-tinted guide screenshot.
  const guideUrl = hasScope ? null : toDataUrl(request.regionGuideImageDataUrl || "");
  const hasGuide = Boolean(guideUrl);
  const photosMasked = Boolean(request.photosMasked);
  const measureFactor =
    typeof request.measureFactor === "number" &&
    Number.isFinite(request.measureFactor) &&
    request.measureFactor > 0
      ? request.measureFactor
      : undefined;
  // A measured area only means something when the scan is calibrated.
  const measuredAreaSqft =
    measureFactor &&
    typeof request.measuredAreaSqft === "number" &&
    Number.isFinite(request.measuredAreaSqft) &&
    request.measuredAreaSqft > 0
      ? request.measuredAreaSqft
      : undefined;

  // --- Pass A: assess damage across nearby photos + pick best frame for outline ---
  onProgress?.("assessing");
  const passAContent: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: buildPassAPrompt({
        projectName: request.projectName,
        imageCount: images.length,
        measureFactor,
        measuredAreaSqft,
        hasGuideImage: hasGuide,
        photosMasked,
        hasScope,
      }),
    },
  ];
  if (scopeUrl) {
    passAContent.push({ type: "image_url", image_url: { url: scopeUrl, detail: "high" } });
  }
  // GUIDE first — visual “stay inside this orange mark”; photos still follow.
  if (guideUrl) {
    passAContent.push({ type: "image_url", image_url: { url: guideUrl, detail: "low" } });
  }
  images.forEach((url) => {
    passAContent.push({ type: "image_url", image_url: { url, detail: "low" } });
  });

  // Pass A, retried once if the answer can't be turned into a report.
  let passA: unknown = null;
  let assessed: WallDamageReport | null = null;
  for (let attempt = 1; attempt <= 2 && !assessed; attempt++) {
    const content =
      attempt === 1
        ? passAContent
        : [
            {
              type: "text",
              text:
                (passAContent[0].text as string) +
                "\n\nIMPORTANT: Your previous answer could not be used. Return ONE JSON object with the schema keys (report_metadata, damage_assessment, cause_analysis, repair_plan, cost_breakdown_estimate, recommendations, best_image_index, outline_image_indices) at the TOP LEVEL. No wrapper object, no markdown, no text.",
            },
            ...passAContent.slice(1),
          ];
    try {
      const raw = await callDeepSeekJson(key, content, attempt === 1 ? 0.2 : 0.1, `pass A #${attempt}`);
      const root = unwrapReportRoot(raw);
      const merged = mergeReport(root);
      if (isUsableReport(merged)) {
        passA = root;
        assessed = merged;
      } else {
        console.warn(
          `[damage] pass A #${attempt}: JSON had no report content. Top-level keys:`,
          Object.keys(asRecord(raw)).join(", ") || "(none)",
        );
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      // HTTP / network errors keep their message; unreadable output is retried.
      if (/DeepSeek error \(|fetch failed|ENOTFOUND|ECONN|ETIMEDOUT/i.test(raw)) throw error;
      console.warn(`[damage] pass A #${attempt} failed:`, raw);
    }
  }
  if (!assessed) {
    throw new Error(INCOMPLETE_ANALYSIS);
  }
  let report: WallDamageReport = assessed;

  // Area: the calibrated 3D measurement wins over the model's photo guess.
  const areaInfo = report.damage_assessment.damaged_area_estimation;
  if (measuredAreaSqft) {
    areaInfo.model_estimated_area_sqft = areaInfo.estimated_total_area_sqft || undefined;
    areaInfo.estimated_total_area_sqft = Math.round(measuredAreaSqft * 10) / 10;
    areaInfo.area_source = "measured";
  } else {
    areaInfo.area_source = "estimated";
  }
  // Backstop: symptoms but no priced items → ask for a cost breakdown on its own.
  if (
    report.damage_assessment.visible_symptoms.length > 0 &&
    report.cost_breakdown_estimate.line_items.length === 0
  ) {
    report.cost_breakdown_estimate.line_items = await runCostPass(key, report);
  }
  report = computeCostTotals(report);

  // Photos Pass A judged to show the marked area best — shown as close-ups.
  const referenceImageIndices = parseOutlineImageIndices(passA, images.length);

  const symptoms = report.damage_assessment.visible_symptoms;
  if (symptoms.length === 0) {
    // Nothing to outline — return the (honest, "no damage seen") report.
    return {
      report,
      model: DEEPSEEK_MODEL,
      imageCount: images.length,
      referenceImageIndices,
      outline: null,
      outlines: [],
    };
  }

  const candidateIndices = parseOutlineImageIndices(passA, images.length);
  const symptomLines = symptoms
    .map((s) => [s.type, s.description].filter(Boolean).join(": "))
    .slice(0, 12);

  async function runPassBOnImage(
    imageIndex: number,
    mustCover?: number[],
  ): Promise<DamageOutline | null> {
    const url = images[imageIndex];
    if (!url) return null;
    try {
      const passBContent: Array<Record<string, unknown>> = [
        {
          type: "text",
          text: buildPassBPrompt({
            severity: report.damage_assessment.severity_level,
            symptoms: symptomLines,
            mustCover,
            hasGuideImage: hasGuide,
            photoMasked: photosMasked,
          }),
        },
      ];
      if (guideUrl) {
        passBContent.push({ type: "image_url", image_url: { url: guideUrl, detail: "low" } });
      }
      passBContent.push({ type: "image_url", image_url: { url, detail: "high" } });
      const passB = await callDeepSeekJson(key, passBContent, 0.1, `pass B (photo ${imageIndex})`);
      const local = parseOutline(passB, 1, symptoms.length);
      if (!local || local.regions.length === 0) return null;
      return { imageIndex, regions: local.regions };
    } catch {
      return null;
    }
  }

  onProgress?.("outlining");

  // Photos could not be mapped to the mark → outline on the SCOPE crop itself, which is
  // exactly the marked area. Outlines on unmapped photos can't be kept in scope.
  if (scopeUrl && !photosMasked) {
    let scopeOutline: DamageOutline | null = null;
    const size = request.scopeImageSize;
    for (let attempt = 1; attempt <= 2 && !scopeOutline; attempt++) {
      try {
        const reminder =
          attempt === 1
            ? ""
            : `\n\nIMPORTANT: The assessment already found ${symptoms.length} issue(s) inside this area. Outline EACH of them with its own region. Use NORMALIZED 0–1 coordinates (x / image width, y / image height).`;
        const passB = await callDeepSeekJson(
          key,
          [
            {
              type: "text",
              text:
                buildPassBPrompt({
                  severity: report.damage_assessment.severity_level,
                  symptoms: symptomLines,
                  hasGuideImage: false,
                  photoMasked: false,
                  onScope: true,
                  imageSize: size,
                }) + reminder,
            },
            { type: "image_url", image_url: { url: scopeUrl, detail: "high" } },
          ],
          attempt === 1 ? 0.1 : 0.2,
          `pass B (scope) #${attempt}`,
        );
        const local = parseOutline(passB, 1, symptoms.length, size);
        if (local && local.regions.length > 0) {
          scopeOutline = { imageIndex: 0, target: "scope", regions: local.regions };
        } else {
          console.warn(
            `[damage] pass B (scope) #${attempt}: no usable regions. Raw:`,
            JSON.stringify(passB).slice(0, 600),
          );
        }
      } catch (error) {
        console.warn(`[damage] pass B (scope) #${attempt} failed:`, error instanceof Error ? error.message : error);
      }
    }
    return {
      report,
      model: DEEPSEEK_MODEL,
      imageCount: images.length,
      referenceImageIndices,
      outline: scopeOutline,
      outlines: scopeOutline ? [scopeOutline] : [],
    };
  }

  // --- Pass B #1: always outline the primary/best photo ---
  const outlines: DamageOutline[] = [];
  let coveredRegions: DamageOutlineRegion[] = [];
  const primaryIndex = candidateIndices[0] ?? 0;
  const primary = await runPassBOnImage(primaryIndex);
  if (primary) {
    outlines.push(primary);
    coveredRegions = [...primary.regions];
  }

  // --- Extra Pass B only when needed, run in parallel ---
  // Needed if Pass A asked for more photos, or some symptoms are still not outlined.
  const missing = uncoveredSymptomIndices(report, coveredRegions);
  const suggestedExtras = candidateIndices.slice(1);
  if ((suggestedExtras.length > 0 || missing.length > 0) && images.length > 1) {
    const queue: number[] = [];
    for (const idx of suggestedExtras) {
      if (idx !== primaryIndex && !queue.includes(idx)) queue.push(idx);
    }
    // Pass A gave one photo but symptoms are still missing → try the next nearby frames.
    if (missing.length > 0) {
      for (let i = 0; i < images.length && queue.length < 2; i++) {
        if (i !== primaryIndex && !queue.includes(i)) queue.push(i);
      }
    }
    const extras = await Promise.all(
      queue.slice(0, 2).map((idx) => runPassBOnImage(idx, missing)),
    );
    for (const extra of extras) {
      if (!extra || extra.regions.length === 0) continue;
      // Keep an extra photo only if it outlines something new (or Pass A asked for it).
      const before = uncoveredSymptomIndices(report, coveredRegions).length;
      const after = uncoveredSymptomIndices(report, coveredRegions.concat(extra.regions)).length;
      if (after < before || suggestedExtras.includes(extra.imageIndex)) {
        outlines.push(extra);
        coveredRegions = coveredRegions.concat(extra.regions);
      }
    }
  }

  return {
    report,
    model: DEEPSEEK_MODEL,
    imageCount: images.length,
    referenceImageIndices,
    outline: outlines[0] ?? null,
    outlines,
  };
}

export function registerDamageIpc(): void {
  handle(
    DAMAGE_CHANNELS.analyze,
    async (event, payload: DamageAnalyzeRequest): Promise<DamageAnalyzeResponse> => {
      try {
        return await analyzeWallDamage(payload, (stage) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(DAMAGE_CHANNELS.progressEvent, {
              requestId: payload.requestId,
              stage,
            });
          }
        });
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        if (raw === INCOMPLETE_ANALYSIS) throw new Error(raw);
        if (/api key missing/i.test(raw)) {
          throw new Error("Damage estimation is not configured on this computer (missing API key).");
        }
        if (/DeepSeek error \((401|403)\)/.test(raw)) {
          throw new Error("Damage estimation service rejected the request (check the API key).");
        }
        if (/DeepSeek error \(429\)/.test(raw)) {
          throw new Error("Damage estimation service is busy. Wait a minute and try again.");
        }
        if (/fetch failed|ENOTFOUND|ECONN|ETIMEDOUT/i.test(raw)) {
          throw new Error("Could not reach the damage estimation service. Check your internet connection.");
        }
        // Keep everything else user-facing and free of vendor/API internals.
        throw new Error("Could not complete damage estimation. Try marking the area again.");
      }
    },
  );
}
