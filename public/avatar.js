// Builds a cartoon portrait as an SVG string from a character's attributes.
// Every attribute has a distinct *shape*, and hair colour also gets a texture (patterns in
// index.html), so the board stays readable for colourblind players.
(function () {
  // Three skin tones, far apart so "light" and "dark" are never a judgement call.
  const SKIN = {
    light:  { base: "#f9dcc8", shade: "#e9bfa5" },
    medium: { base: "#c98f5b", shade: "#ab7444" },
    dark:   { base: "#5e3820", shade: "#462815" },
  };
  // Older rooms (from before the 3-tone change) may still use these names.
  SKIN.tan = SKIN.medium; SKIN.olive = SKIN.medium; SKIN.brown = SKIN.dark;
  // Hair: base colour, highlight and the eyebrow colour that matches it.
  const HAIR = {
    black: { base: "#2a2321", hi: "#544641", brow: "#1d1715" },
    brown: { base: "#6e4424", hi: "#9b6a3f", brow: "#4a2c16" },
    blond: { base: "#e9c45c", hi: "#f8e29a", brow: "#b38b2e" },
    red:   { base: "#bf4528", hi: "#e47552", brow: "#8a2f1a" },
    grey:  { base: "#a3a8ad", hi: "#d4d8db", brow: "#7b8086" },
    none:  { base: "#3b2a20", hi: "#3b2a20", brow: "#3b2a20" },
  };
  const BG = ["#ffd6a5", "#caffbf", "#9bf6ff", "#bdb2ff", "#ffc6ff", "#fdffb6", "#a0c4ff", "#ffadad"];
  const SHIRT = ["#e63946", "#457b9d", "#2a9d8f", "#f4a261", "#6d597a", "#264653", "#e76f51", "#5e8b4e"];
  const IRIS = ["#4a2e1b", "#2f1c10", "#6b4a26", "#3d3020"];

  // A shape in the hair colour, plus the colourblind texture on top.
  function hair(tag, attrs, color) {
    const h = HAIR[color] || HAIR.black;
    const tex = color === "black" || color === "none" ? "" : `<${tag} ${attrs} fill="url(#tex-${color})"/>`;
    return `<${tag} ${attrs} fill="${h.base}"/>${tex}`;
  }
  // Soft highlight stroke along the top of the hair.
  const shine = (d, color) => `<path d="${d}" stroke="${(HAIR[color] || HAIR.black).hi}" stroke-width="2.4" fill="none" stroke-linecap="round" opacity=".8"/>`;

  // ---------- hair behind the head ----------
  function backHair(c) {
    switch (c.hairStyle) {
      case "long":
        return hair("path", `d="M27 46 Q24 19 50 18 Q76 19 73 46 L79 97 Q68 103 60 94 L40 94 Q32 103 21 97 Z"`, c.hairColor);
      case "curly":
        return [[29, 40, 10], [71, 40, 10], [25, 54, 9], [75, 54, 9], [28, 68, 9], [72, 68, 9], [34, 79, 7], [66, 79, 7]]
          .map(([x, y, r]) => hair("circle", `cx="${x}" cy="${y}" r="${r}"`, c.hairColor)).join("");
      case "ponytail":
        return hair("path", `d="M65 31 Q93 34 87 84 Q85 94 78 89 Q81 66 67 47 Z"`, c.hairColor)
          + `<rect x="64" y="33" width="7" height="4" rx="2" transform="rotate(35 67 35)" fill="#e63972"/>`;
      case "bun":
        return hair("circle", `cx="50" cy="15" r="10.5"`, c.hairColor)
          + shine("M44 10 Q49 6 55 9", c.hairColor)
          + `<rect x="43" y="22" width="14" height="4" rx="2" fill="#e63972"/>`;
      default:
        return "";
    }
  }

  // ---------- hair in front (hairline) ----------
  function frontHair(c) {
    const col = c.hairColor;
    switch (c.hairStyle) {
      case "bald":
        return `<ellipse cx="42" cy="33" rx="6" ry="3" fill="#fff" opacity=".35" transform="rotate(-20 42 33)"/>`;
      case "short":
        return hair("path", `d="M29 49 Q26 23 50 22 Q74 23 71 49 Q69 38 63 33 Q57 37 47 35 Q37 34 31 41 Z"`, col)
          + shine("M37 27 Q46 23 56 25", col);
      case "long":
        return hair("path", `d="M29 52 Q27 22 50 21 Q73 22 71 52 Q67 35 53 31 Q50 37 45 39 Q37 42 29 52 Z"`, col)
          + shine("M36 27 Q45 22 55 24", col);
      case "curly":
        return [[33, 34, 8], [40, 27, 8], [50, 24, 8.5], [60, 27, 8], [67, 34, 8], [30, 44, 6], [70, 44, 6]]
          .map(([x, y, r]) => hair("circle", `cx="${x}" cy="${y}" r="${r}"`, col)
            + `<circle cx="${x - 2}" cy="${y - 2}" r="${r * 0.35}" fill="${(HAIR[col] || HAIR.black).hi}" opacity=".55"/>`).join("");
      case "ponytail":
      case "bun":
        return hair("path", `d="M29 49 Q27 22 50 21 Q73 22 71 49 Q63 30 50 29 Q37 30 29 49 Z"`, col)
          + shine("M38 26 Q46 22 55 24", col);
      default:
        return "";
    }
  }

  // ---------- face ----------
  function face(c) {
    const s = SKIN[c.skin] || SKIN.medium;
    const female = c.gender === "female";
    const brow = (HAIR[c.hairColor] || HAIR.none).brow;
    const iris = IRIS[(c.id || 0) % IRIS.length];
    const browW = female ? 1.7 : 2.4;

    const eye = (x, mirror) => `
      <ellipse cx="${x}" cy="52" rx="4.3" ry="3.5" fill="#fff"/>
      <circle cx="${x + 0.3}" cy="52.4" r="2.6" fill="${iris}"/>
      <circle cx="${x + 0.3}" cy="52.4" r="1.25" fill="#0d0907"/>
      <circle cx="${x + 1.2}" cy="51.4" r=".85" fill="#fff"/>
      <path d="M${x - 4.4} 51.6 Q${x} 47.6 ${x + 4.4} 51.6" stroke="#2b1d14" stroke-width="${female ? 1.6 : 1.2}" fill="none" stroke-linecap="round"/>
      ${female ? `<path d="M${x + mirror * 4.1} 50.4 l${mirror * 2.2} -1.9 M${x + mirror * 2.6} 49 l${mirror * 1.4} -2.1 M${x + mirror * 0.8} 48.3 l${mirror * 0.5} -2.1" stroke="#2b1d14" stroke-width="1.15" stroke-linecap="round"/>` : ""}`;

    // A few different smiles, so the board feels alive (not a question trait).
    const mouths = [
      `<path d="M44.5 67 Q50 71.5 55.5 67" stroke="#6b2a1f" stroke-width="1.8" fill="none" stroke-linecap="round"/>`,
      `<path d="M44 66.5 Q50 73.5 56 66.5 Z" fill="#7a2626"/><path d="M45.3 67 Q50 68.6 54.7 67 L54.2 68.2 Q50 69.4 45.8 68.2 Z" fill="#fff"/>`,
      `<path d="M45 67.6 Q50.5 70.6 55.5 66.4" stroke="#6b2a1f" stroke-width="1.8" fill="none" stroke-linecap="round"/>`,
    ];
    const mouth = female
      ? `<path d="M44.5 66.6 Q47.5 65 50 66.2 Q52.5 65 55.5 66.6 Q50 72 44.5 66.6 Z" fill="#c8505d"/><path d="M45.5 66.9 Q50 68.4 54.5 66.9" stroke="#8e2f3b" stroke-width=".7" fill="none"/>`
      : mouths[(c.id || 0) % mouths.length];

    return `
      <!-- ears -->
      <ellipse cx="29.5" cy="54" rx="4" ry="6" fill="${s.base}"/><ellipse cx="29.8" cy="54" rx="1.8" ry="3.2" fill="${s.shade}"/>
      <ellipse cx="70.5" cy="54" rx="4" ry="6" fill="${s.base}"/><ellipse cx="70.2" cy="54" rx="1.8" ry="3.2" fill="${s.shade}"/>
      <!-- head -->
      <path d="${female
        ? "M30 50 Q30 27 50 27 Q70 27 70 50 Q70 66 61 74 Q55.5 78.5 50 78.5 Q44.5 78.5 39 74 Q30 66 30 50 Z"
        : "M30 50 Q30 27 50 27 Q70 27 70 50 Q70.6 67 63.5 74.5 Q57.5 79.2 50 79.2 Q42.5 79.2 36.5 74.5 Q29.4 67 30 50 Z"}" fill="${s.base}" stroke="rgba(0,0,0,.12)" stroke-width=".8"/>
      <path d="M62 30 Q70 38 70 50 Q70 68 60 75 Q55 78.5 50 78.5 Q60 70 63 55 Q65 42 62 30 Z" fill="${s.shade}" opacity=".45"/>
      <!-- cheeks -->
      <ellipse cx="38" cy="61.5" rx="4" ry="2.4" fill="#ff6f7d" opacity="${female ? 0.32 : 0.18}"/>
      <ellipse cx="62" cy="61.5" rx="4" ry="2.4" fill="#ff6f7d" opacity="${female ? 0.32 : 0.18}"/>
      <!-- brows, eyes, nose -->
      <path d="M35.5 45.5 Q40.5 42.2 45.5 44.6" stroke="${brow}" stroke-width="${browW}" fill="none" stroke-linecap="round"/>
      <path d="M54.5 44.6 Q59.5 42.2 64.5 45.5" stroke="${brow}" stroke-width="${browW}" fill="none" stroke-linecap="round"/>
      ${eye(41, -1)}${eye(59, 1)}
      <path d="M50.5 55 Q48.2 60.5 50.2 62.2 Q52 63 53.4 61.6" stroke="${s.shade}" stroke-width="1.6" fill="none" stroke-linecap="round"/>
      <!-- mouth -->
      ${mouth}`;
  }

  // Facial hair is drawn over the jaw; the mouth is redrawn on top so it stays visible.
  function facialHair(c) {
    const col = c.hairColor === "none" ? "black" : c.hairColor;
    if (c.facialHair === "beard") {
      return hair("path", `d="M30 52 Q30 70 39 77 Q44 82 50 82.5 Q56 82 61 77 Q70 70 70 52 Q67 64 60 66 Q55 64 50 64.6 Q45 64 40 66 Q33 64 30 52 Z"`, col)
        + `<path d="M44.5 68 Q50 71.6 55.5 68 Q50 70 44.5 68 Z" fill="#7a2626"/>`;
    }
    if (c.facialHair === "mustache") {
      // Handlebar shape: clearly different from a beard.
      return hair("path", `d="M37 65 Q42 59.5 50 63.2 Q58 59.5 63 65 Q65.5 68.5 62 67.4 Q56 63.8 50 66.6 Q44 63.8 38 67.4 Q34.5 68.5 37 65 Z"`, col);
    }
    return "";
  }

  // ---------- accessories ----------
  function hat() {
    return `
      <path d="M31.5 31 Q30.5 9 50 8.5 Q69.5 9 68.5 31 Z" fill="#2f3e7a"/>
      <path d="M44 9.5 Q50 14 56 9.5" stroke="#1f2a57" stroke-width="1.6" fill="none"/>
      <path d="M58 11 Q66 14 67.5 29 L63 30 Q63 17 58 11 Z" fill="#1f2a57" opacity=".5"/>
      <rect x="31.2" y="24" width="37.6" height="5" fill="#f4c542"/>
      <ellipse cx="50" cy="31.5" rx="30" ry="5.5" fill="#253265"/>
      <ellipse cx="50" cy="30.6" rx="27" ry="3.4" fill="#33448a"/>`;
  }

  function glasses() {
    return `<g>
      <rect x="33.6" y="46.6" width="14.4" height="11.4" rx="4.5" fill="rgba(200,230,255,.22)" stroke="#161616" stroke-width="2"/>
      <rect x="52" y="46.6" width="14.4" height="11.4" rx="4.5" fill="rgba(200,230,255,.22)" stroke="#161616" stroke-width="2"/>
      <path d="M48 51 Q50 49.4 52 51 M33.6 50.5 L29 48.5 M66.4 50.5 L71 48.5" stroke="#161616" stroke-width="2" fill="none" stroke-linecap="round"/>
      <path d="M36 49.5 L39.5 48.6 M54.4 49.5 L57.9 48.6" stroke="#fff" stroke-width="1.2" stroke-linecap="round" opacity=".8"/>
    </g>`;
  }

  function earrings() {
    // Gold hoop with a drop: a distinct shape, not just a coloured dot.
    const one = x => `<circle cx="${x}" cy="61.8" r="2.6" fill="none" stroke="#e1a92b" stroke-width="1.5"/>
      <path d="M${x} 63.6 l2 3 -2 3 -2 -3 Z" fill="#f4c542" stroke="#9a7015" stroke-width=".6"/>`;
    return one(29.5) + one(70.5);
  }

  // ---------- body ----------
  function body(c) {
    const s = SKIN[c.skin] || SKIN.medium;
    const id = c.id || 0;
    const female = c.gender === "female";
    const shirt = SHIRT[(id * 3) % SHIRT.length];
    const neckline = [
      // V-neck
      `<path d="M41 85 L50 96 L59 85 Z" fill="${s.base}"/>`,
      // collar points
      `<path d="M43 84.5 L50 92 L45 95 L39.5 87 Z" fill="#fff"/><path d="M57 84.5 L50 92 L55 95 L60.5 87 Z" fill="#fff"/>`,
      // round neck
      `<path d="M41.5 85 Q50 91.5 58.5 85" stroke="rgba(0,0,0,.25)" stroke-width="2" fill="none"/>`,
    ][id % 3];
    return `
      <path d="M43 70 L57 70 L57.5 87 L42.5 87 Z" fill="${s.base}"/>
      <path d="M43 74 Q50 79 57 74 L57 78 Q50 82 43 78 Z" fill="${s.shade}" opacity=".7"/>
      ${female
        // narrower, rounder shoulders
        ? `<path d="M19 110 Q20 92 36 87 Q42 85 44 85 L50 90 L56 85 Q58 85 64 87 Q80 92 81 110 Z" fill="${shirt}"/>
           <path d="M19 110 Q20 92 36 87 L38 110 Z" fill="rgba(255,255,255,.08)"/>`
        // broad, squarer shoulders
        : `<path d="M10 110 Q11 89 33 85 Q42 83.6 44 84.5 L50 90 L56 84.5 Q58 83.6 67 85 Q89 89 90 110 Z" fill="${shirt}"/>
           <path d="M10 110 Q11 89 33 85 L35 110 Z" fill="rgba(255,255,255,.08)"/>`}
      ${neckline}`;
  }

  function describe(c) {
    const parts = [c.gender, `${c.skin} skin`, c.hairStyle === "bald" ? "bald" : `${c.hairColor} ${c.hairStyle} hair`];
    if (c.facialHair !== "none") parts.push(c.facialHair);
    if (c.accessory.length) parts.push(c.accessory.join(" and "));
    if (c.hat) parts.push("hat");
    return `${c.name}: ${parts.join(", ")}`;
  }

  // opts.crop: square close-up of the head (used for question pictures).
  // opts.decorative: hidden from screen readers (the caller provides the text).
  window.renderAvatar = function (c, opts = {}) {
    const id = c.id || 0;
    const bg = BG[id % BG.length];
    const viewBox = opts.crop ? "8 5 84 84" : "0 0 100 110";
    const a11y = opts.decorative
      ? `aria-hidden="true" focusable="false">`
      : `role="img" aria-label="${describe(c)}"><title>${describe(c)}</title>`;
    return `<svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg" ${a11y}
      <rect width="100" height="110" fill="${bg}"/>
      <circle cx="28" cy="18" r="46" fill="#fff" opacity=".22"/>
      ${backHair(c)}
      ${body(c)}
      ${face(c)}
      ${facialHair(c)}
      ${c.accessory.includes("earrings") ? earrings() : ""}
      ${frontHair(c)}
      ${c.accessory.includes("glasses") ? glasses() : ""}
      ${c.hat ? hat() : ""}
    </svg>`;
  };
  window.describeCharacter = describe;
})();
