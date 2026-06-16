import { createUniqueId, type ComponentProps } from "solid-js"

const CELL = 12
const HALF = CELL / 2
const LEFT = [
  "▄                                 ",
  "█▀▀█ █▀▀▄ █▀▀█ █  █ █▀▀▀ █▀▀█ █▀▀▄",
  "█__█ █___ █__█ █▐▌█ ^^^█ █^^^ █___",
  "▀▀▀▀ ▀~~~ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀~~~",
]
const RIGHT = ["             ▄     ", "█▀▀▀ █▀▀█ █▀▀█ █▀▀█", "█___ █__█ █__█ █^^^", "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"]
const GAP = 1

type Rect = {
  x: number
  y: number
  width: number
  height: number
  fill: "fill" | "weak" | "shadow"
}

function rects(rows: string[], offset: number): Rect[] {
  return rows.flatMap((row, y) =>
    [...row].flatMap((char, x): Rect[] => {
      const cell = { x: (offset + x) * CELL, y: y * CELL }
      if (char === "█") return [{ ...cell, width: CELL, height: CELL, fill: "fill" as const }]
      if (char === "▀") return [{ ...cell, width: CELL, height: HALF, fill: "fill" as const }]
      if (char === "▄") return [{ ...cell, y: cell.y + HALF, width: CELL, height: HALF, fill: "fill" as const }]
      if (char === "▐") return [{ ...cell, x: cell.x + HALF, width: HALF, height: CELL, fill: "fill" as const }]
      if (char === "_") return [{ ...cell, width: CELL, height: CELL, fill: "weak" as const }]
      if (char === "^") {
        return [
          { ...cell, width: CELL, height: CELL, fill: "weak" as const },
          { ...cell, width: CELL, height: HALF, fill: "fill" as const },
        ]
      }
      if (char === "~") return [{ ...cell, width: CELL, height: HALF, fill: "shadow" as const }]
      return []
    }),
  )
}

export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  const filter = createUniqueId()
  const mask = createUniqueId()
  const maskGradient = createUniqueId()
  const left = rects(LEFT, 0)
  const right = rects(RIGHT, LEFT[1].length + GAP)
  const width = (LEFT[1].length + GAP + RIGHT[1].length) * CELL
  const height = LEFT.length * CELL

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      preserveAspectRatio="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g opacity="0.16" filter={`url(#${filter})`} mask={`url(#${mask})`}>
        {left.map((rect) => (
          <rect
            x={rect.x}
            y={rect.y}
            width={rect.width}
            height={rect.height}
            fill={rect.fill === "fill" ? "var(--v2-icon-icon-muted)" : "currentColor"}
            opacity={rect.fill === "fill" ? 0.72 : rect.fill === "weak" ? 0.2 : 0.12}
          />
        ))}
        {right.map((rect) => (
          <rect
            x={rect.x}
            y={rect.y}
            width={rect.width}
            height={rect.height}
            fill="currentColor"
            opacity={rect.fill === "fill" ? 0.72 : rect.fill === "weak" ? 0.2 : 0.12}
          />
        ))}
      </g>
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width={width} height={height}>
          <rect width={width} height={height} fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient id={maskGradient} x1={width / 2} y1="0" x2={width / 2} y2={height} gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
        <filter
          id={filter}
          x="0"
          y="0"
          width={width}
          height={height}
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB"
        >
          <feFlood flood-opacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="1" />
          <feGaussianBlur stdDeviation="1" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" />
          <feBlend mode="normal" in2="shape" result="effect1_innerShadow_4938_16028" />
        </filter>
      </defs>
    </svg>
  )
}
