// Builds a cartoon face as an SVG string from a character's attributes.
// Every attribute has a distinct *shape*, and hair color also gets a texture (see index.html),
// so the board stays readable for colorblind players.
(function () {
  const SKIN = { light: "#f7d9c4", tan: "#e2b48a", olive: "#bfa074", brown: "#9c6644", dark: "#5e3a24" };
  const HAIR = { black: "#272121", brown: "#6b4423", blond: "#efcd6b", red: "#c0462b", grey: "#9ea3a8" };
  const BG = ["#ffd6a5", "#caffbf", "#9bf6ff", "#bdb2ff", "#ffc6ff", "#fdffb6", "#a0c4ff", "#ffadad"];
  const SHIRT = ["#e63946", "#457b9d", "#2a9d8f", "#f4a261", "#6d597a", "#264653", "#e76f51", "#8ab17d"];

  // Draw a shape filled with the hair color, then the same shape again with the texture overlay.
  function hairShape(tag, attrs, color) {
    const fill = HAIR[color] || "#000";
    const tex = color === "black" ? "" : `<${tag} ${attrs} fill="url(#tex-${color})"/>`;
    return `<${tag} ${attrs} fill="${fill}"/>${tex}`;
  }

  function backHair(c) {
    switch (c.hairStyle) {
      case "long":
        return hairShape("path", `d="M25 48 Q24 18 50 18 Q76 18 75 48 L80 96 L20 96 Z"`, c.hairColor);
      case "curly":
        return [[30, 40], [70, 40], [27, 56], [73, 56], [32, 70], [68, 70]]
          .map(([x, y]) => hairShape("circle", `cx="${x}" cy="${y}" r="10"`, c.hairColor)).join("");
      case "ponytail":
        return hairShape("path", `d="M66 30 Q92 34 86 86 Q80 64 68 48 Z"`, c.hairColor);
      case "bun":
        return hairShape("circle", `cx="50" cy="17" r="10"`, c.hairColor);
      default:
        return "";
    }
  }

  function frontHair(c) {
    const cap = `d="M28 52 Q26 20 50 20 Q74 20 72 52 Q68 34 50 32 Q32 34 28 52 Z"`;
    switch (c.hairStyle) {
      case "bald":
        return `<path d="M38 32 Q44 28 50 29" stroke="rgba(255,255,255,.55)" stroke-width="3" fill="none" stroke-linecap="round"/>`;
      case "short":
        return hairShape("path", `d="M29 46 Q28 22 50 22 Q72 22 71 46 Q66 32 50 31 Q34 32 29 46 Z"`, c.hairColor);
      case "long":
        return hairShape("path", cap, c.hairColor);
      case "curly":
        return [[33, 34], [41, 26], [50, 23], [59, 26], [67, 34]]
          .map(([x, y]) => hairShape("circle", `cx="${x}" cy="${y}" r="8"`, c.hairColor)).join("");
      case "ponytail":
      case "bun":
        return hairShape("path", `d="M29 48 Q28 22 50 22 Q72 22 71 48 Q60 30 50 30 Q40 30 29 48 Z"`, c.hairColor);
      default:
        return "";
    }
  }

  function facialHair(c) {
    if (c.facialHair === "beard") {
      return hairShape("path", `d="M29 54 Q30 88 50 89 Q70 88 71 54 Q68 72 50 74 Q32 72 29 54 Z"`, c.hairColor === "none" ? "black" : c.hairColor)
        + hairShape("path", `d="M40 66 Q50 61 60 66 Q50 64 40 66 Z"`, c.hairColor === "none" ? "black" : c.hairColor);
    }
    if (c.facialHair === "mustache") {
      // A handlebar shape, clearly different from a beard.
      return hairShape("path", `d="M36 64 Q42 59 50 63 Q58 59 64 64 Q66 68 62 67 Q56 64 50 67 Q44 64 38 67 Q34 68 36 64 Z"`, c.hairColor === "none" ? "black" : c.hairColor);
    }
    return "";
  }

  function hat() {
    return `<path d="M32 30 Q32 8 50 8 Q68 8 68 30 Z" fill="#2f3e7a"/>
      <rect x="32" y="24" width="36" height="5" fill="#f4d35e"/>
      <ellipse cx="50" cy="31" rx="29" ry="5" fill="#253265"/>`;
  }

  function glasses() {
    return `<g fill="rgba(255,255,255,.25)" stroke="#111" stroke-width="2">
      <rect x="33" y="44" width="14" height="11" rx="3"/>
      <rect x="53" y="44" width="14" height="11" rx="3"/>
      <path d="M47 49 H53 M33 48 L29 46 M67 48 L71 46" fill="none"/>
    </g>`;
  }

  function earrings() {
    // Diamond-shaped drops (distinct shape, not just a color dot).
    const drop = x => `<path d="M${x} 59 L${x + 3} 63 L${x} 67 L${x - 3} 63 Z" fill="#f2c94c" stroke="#8a6d1d" stroke-width=".8"/>`;
    return drop(29) + drop(71);
  }

  function face(c) {
    const skin = SKIN[c.skin] || SKIN.tan;
    const female = c.gender === "female";
    const lashes = female
      ? `<path d="M37 47 L35 45 M40 46 L39 44 M60 46 L61 44 M63 47 L65 45" stroke="#111" stroke-width="1.2"/>`
      : "";
    const lips = female
      ? `<path d="M43 70 Q50 76 57 70 Q50 72 43 70 Z" fill="#c4505e"/>`
      : `<path d="M43 70 Q50 75 57 70" stroke="#5a2e1e" stroke-width="2" fill="none" stroke-linecap="round"/>`;
    return `
      <circle cx="29" cy="54" r="5" fill="${skin}"/>
      <circle cx="71" cy="54" r="5" fill="${skin}"/>
      <ellipse cx="50" cy="52" rx="21" ry="25" fill="${skin}"/>
      <circle cx="40" cy="49" r="2.6" fill="#111"/>
      <circle cx="60" cy="49" r="2.6" fill="#111"/>
      ${lashes}
      <path d="M35 42 Q40 39 45 42 M55 42 Q60 39 65 42" stroke="rgba(0,0,0,.6)" stroke-width="1.6" fill="none"/>
      <path d="M50 52 Q47 59 51 60" stroke="rgba(0,0,0,.35)" stroke-width="1.6" fill="none"/>
      ${lips}`;
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
    const shirt = SHIRT[(id * 3) % SHIRT.length];
    const skin = SKIN[c.skin] || SKIN.tan;
    const viewBox = opts.crop ? "8 5 84 84" : "0 0 100 110";
    const a11y = opts.decorative
      ? `aria-hidden="true" focusable="false">`
      : `role="img" aria-label="${describe(c)}"><title>${describe(c)}</title>`;
    return `<svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg" ${a11y}
      <rect width="100" height="110" fill="${bg}"/>
      ${backHair(c)}
      <rect x="43" y="70" width="14" height="18" fill="${skin}"/>
      <path d="M16 110 Q18 86 50 84 Q82 86 84 110 Z" fill="${shirt}"/>
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
