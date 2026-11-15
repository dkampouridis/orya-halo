/*
 * Stand-in globe for the Orya Halo HUD mockup.
 *
 * This is NOT the engine. It paints one orthographic frame of the Earth on a 2D canvas so the
 * HUD's contrast and composition can be judged over something honest: true-black space, a
 * shaded day and night side, city lights, and a believable scatter of live objects.
 * Everything here is synthetic except coastlines (world-atlas / Natural Earth) and city
 * positions (Natural Earth populated places).
 */
(function () {
  "use strict";

  const RAD = Math.PI / 180;
  const ACCENT = {
    aircraft: [79, 227, 255],
    ships: [255, 178, 36],
    satellites: [176, 140, 255],
    quakes: [255, 82, 71],
    cables: [31, 191, 163],
    nightlights: [255, 217, 160],
  };
  const RIM = [127, 180, 255];
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  /* ---------- small maths ---------- */

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const smooth = (a, b, v) => {
    const t = clamp((v - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const vec = (lon, lat) => {
    const l = lon * RAD;
    const p = lat * RAD;
    const c = Math.cos(p);
    return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)];
  };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const angle = (a, b) => Math.acos(clamp(dot(a, b), -1, 1));
  function slerp(a, b, t) {
    const d = angle(a, b);
    const s = Math.sin(d);
    if (s < 1e-6) return a;
    const A = Math.sin((1 - t) * d) / s;
    const B = Math.sin(t * d) / s;
    return [A * a[0] + B * b[0], A * a[1] + B * b[1], A * a[2] + B * b[2]];
  }
  const norm = (v) => {
    const m = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / m, v[1] / m, v[2] / m];
  };
  const gauss = (rnd) => (rnd() + rnd() + rnd() + rnd() - 2) * 0.87;

  /* ---------- the sun ---------- */

  /** Unit vector to the subsolar point for a UTC instant. Good to about a degree. */
  function sunVector(ms) {
    const d = new Date(ms);
    const start = Date.UTC(d.getUTCFullYear(), 0, 0);
    const n = (ms - start) / 86400000;
    const decl = -23.44 * Math.cos(((2 * Math.PI) / 365) * (n + 10));
    const b = (2 * Math.PI * (n - 81)) / 364;
    const eot = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
    const hours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
    const lon = -15 * (hours - 12 + eot / 60);
    return vec(lon, decl);
  }

  /* ---------- synthetic traffic ---------- */

  // [iata, lon, lat, weight]
  const AIRPORTS = [
    ["LHR", -0.45, 51.47, 10],
    ["CDG", 2.55, 49.01, 9],
    ["AMS", 4.76, 52.31, 9],
    ["FRA", 8.57, 50.03, 9],
    ["MAD", -3.57, 40.47, 8],
    ["BCN", 2.08, 41.3, 6],
    ["FCO", 12.25, 41.8, 6],
    ["MUC", 11.79, 48.35, 6],
    ["IST", 28.75, 41.26, 9],
    ["LIS", -9.13, 38.77, 5],
    ["DUB", -6.27, 53.43, 5],
    ["ZRH", 8.55, 47.46, 5],
    ["VIE", 16.57, 48.11, 4],
    ["CPH", 12.65, 55.62, 4],
    ["OSL", 11.1, 60.2, 3],
    ["ARN", 17.92, 59.65, 3],
    ["HEL", 24.96, 60.32, 3],
    ["ATH", 23.94, 37.94, 4],
    ["WAW", 20.97, 52.17, 3],
    ["KEF", -22.6, 63.99, 2],
    ["MAN", -2.27, 53.36, 4],
    ["BRU", 4.48, 50.9, 3],
    ["MXP", 8.72, 45.63, 4],
    ["SVO", 37.41, 55.97, 4],
    ["PMI", 2.74, 39.55, 3],
    ["AGP", -4.5, 36.67, 3],
    ["LPA", -15.39, 27.93, 3],
    ["TFS", -16.57, 28.04, 2],
    ["FNC", -16.77, 32.69, 1],
    ["PDL", -25.7, 37.74, 1],
    ["EDI", -3.37, 55.95, 2],
    ["OPO", -8.68, 41.24, 2],
    ["NCE", 7.21, 43.66, 2],
    ["PRG", 14.26, 50.1, 2],
    ["BUD", 19.26, 47.44, 2],
    ["OTP", 26.1, 44.57, 2],
    ["JFK", -73.78, 40.64, 10],
    ["EWR", -74.17, 40.69, 6],
    ["BOS", -71.0, 42.36, 6],
    ["YYZ", -79.63, 43.68, 7],
    ["YUL", -73.74, 45.47, 4],
    ["ORD", -87.9, 41.98, 9],
    ["ATL", -84.43, 33.64, 10],
    ["MIA", -80.29, 25.79, 7],
    ["IAD", -77.46, 38.95, 5],
    ["DFW", -97.04, 32.9, 8],
    ["IAH", -95.34, 29.98, 6],
    ["LAX", -118.4, 33.94, 6],
    ["DEN", -104.67, 39.86, 6],
    ["MEX", -99.07, 19.44, 5],
    ["YHZ", -63.51, 44.88, 1],
    ["CLT", -80.94, 35.21, 6],
    ["PHL", -75.24, 39.87, 4],
    ["DTW", -83.35, 42.21, 4],
    ["MSP", -93.22, 44.88, 4],
    ["MCO", -81.31, 28.43, 5],
    ["CUN", -86.87, 21.04, 3],
    ["YYT", -52.75, 47.62, 1],
    ["BNA", -86.68, 36.12, 3],
    ["TPA", -82.53, 27.98, 3],
    ["GRU", -46.47, -23.43, 8],
    ["GIG", -43.25, -22.81, 4],
    ["EZE", -58.54, -34.82, 5],
    ["BOG", -74.15, 4.7, 6],
    ["LIM", -77.11, -12.02, 4],
    ["SCL", -70.79, -33.39, 4],
    ["PTY", -79.38, 9.07, 4],
    ["SJU", -66.0, 18.44, 2],
    ["PUJ", -68.36, 18.57, 2],
    ["HAV", -82.41, 22.99, 1],
    ["CCS", -66.99, 10.6, 1],
    ["FOR", -38.53, -3.78, 2],
    ["REC", -34.92, -8.13, 2],
    ["BSB", -47.92, -15.87, 3],
    ["SSA", -38.32, -12.91, 2],
    ["CNF", -43.97, -19.62, 2],
    ["CAI", 31.4, 30.12, 5],
    ["CMN", -7.59, 33.37, 3],
    ["ALG", 3.21, 36.69, 2],
    ["TUN", 10.23, 36.85, 2],
    ["LOS", 3.32, 6.58, 3],
    ["ACC", -0.17, 5.6, 2],
    ["DSS", -17.07, 14.67, 1],
    ["ADD", 38.8, 8.98, 3],
    ["NBO", 36.93, -1.32, 2],
    ["JNB", 28.24, -26.13, 3],
    ["CPT", 18.6, -33.97, 2],
    ["LAD", 13.23, -8.86, 1],
    ["ABJ", -3.93, 5.26, 1],
    ["RAK", -8.04, 31.61, 1],
    ["SID", -22.95, 16.74, 1],
    ["DXB", 55.36, 25.25, 8],
    ["DOH", 51.61, 25.27, 6],
    ["JED", 39.16, 21.68, 4],
    ["RUH", 46.7, 24.96, 3],
    ["TLV", 34.89, 32.01, 3],
    ["DEL", 77.1, 28.57, 5],
    ["BOM", 72.87, 19.09, 4],
  ].map((a) => ({ id: a[0], v: vec(a[1], a[2]), w: a[3] }));

  /** The aircraft the detail panel describes: British Airways 115, Heathrow to JFK. */
  const SELECTED = {
    from: vec(-0.45, 51.47),
    to: vec(-73.78, 40.64),
    f: 0.716,
  };

  // Sea lanes as waypoint chains kept in open water. [weight, lateral jitter in degrees, points]
  const LANES = [
    [
      10,
      0.35,
      [
        [100.5, 2.8],
        [98.2, 5.4],
        [95, 6.4],
        [80.5, 5.6],
        [60, 12.2],
        [45.5, 11.9],
        [43.3, 12.6],
        [40.5, 17.5],
        [37, 23],
        [34.2, 27.2],
        [33.75, 27.8],
        [33.1, 28.5],
        [32.75, 29.2],
        [32.55, 29.75],
      ],
    ],
    [
      10,
      0.3,
      [
        [32.4, 31.6],
        [27, 33.6],
        [20, 35.2],
        [14, 36.2],
        [11.4, 37.4],
        [5, 37.6],
        [-1.5, 36.4],
        [-5.6, 35.95],
        [-8, 36.1],
        [-10.2, 37.5],
        [-10.3, 40.5],
        [-10, 43.4],
        [-6.3, 48.4],
        [-2.5, 49.85],
        [0.8, 50.55],
        [1.5, 51.05],
        [2.8, 51.7],
        [3.6, 52.1],
      ],
    ],
    [
      7,
      1.7,
      [
        [-6.3, 48.4],
        [-20, 49.4],
        [-35, 48],
        [-50, 44.2],
        [-62, 41.6],
        [-70, 40.3],
        [-73.4, 40.2],
      ],
    ],
    [
      3,
      1.5,
      [
        [-6.3, 48.4],
        [-25, 50],
        [-45, 47.5],
        [-56, 45.2],
        [-62.5, 44.2],
      ],
    ],
    [
      4,
      1.7,
      [
        [-7.5, 36],
        [-25, 37.5],
        [-45, 39.5],
        [-62, 40.3],
        [-73.4, 40.1],
      ],
    ],
    [
      5,
      1.6,
      [
        [-7.5, 36],
        [-22, 31],
        [-45, 23.5],
        [-60, 20],
        [-67.9, 18.4],
        [-74.5, 13.8],
        [-79.75, 9.6],
      ],
    ],
    [
      5,
      0.4,
      [
        [-73.4, 40.1],
        [-74.2, 37],
        [-75, 34.6],
        [-78.5, 30.8],
        [-79.75, 27],
        [-80.3, 24.6],
        [-83, 24.1],
        [-88, 26],
        [-94.3, 28.9],
      ],
    ],
    [
      5,
      1.0,
      [
        [-10.2, 37.5],
        [-13, 31.5],
        [-17.5, 30],
        [-19, 28],
        [-18.4, 20],
        [-18.3, 14.5],
        [-15.5, 7],
        [-8, 0],
        [0, -11],
        [8, -24],
        [15.5, -32.5],
        [18, -35.4],
        [22, -35.6],
        [26, -34.8],
        [28.6, -33.7],
        [31.5, -31],
      ],
    ],
    [
      4,
      1.0,
      [
        [-18.3, 14.5],
        [-26, 4],
        [-32.5, -4],
        [-34.2, -8.5],
        [-37.5, -15],
        [-40.2, -22.6],
        [-45.5, -24.6],
        [-48.5, -29],
        [-52.5, -34.2],
        [-56, -35.6],
      ],
    ],
    [
      3,
      0.3,
      [
        [-15.5, 7],
        [-9.5, 3.6],
        [-3.5, 4.3],
        [1.5, 5.2],
        [3.4, 6.05],
        [5.5, 3.2],
        [8.3, 0.2],
        [10.6, -5.5],
        [12.6, -8.9],
      ],
    ],
    [
      5,
      0.25,
      [
        [3.6, 52.1],
        [4.3, 54],
        [7, 56.7],
        [9.5, 57.9],
        [11.2, 57.5],
        [11.6, 56.3],
        [12.2, 56.25],
        [12.62, 56.03],
        [12.72, 55.75],
        [12.85, 55.3],
        [13.5, 55.15],
        [14.4, 55.3],
        [15.3, 55.6],
        [17.5, 55.8],
        [20, 58],
        [22.5, 59.4],
        [26, 59.9],
        [28.6, 60],
      ],
    ],
    [
      3,
      0.4,
      [
        [3.6, 52.1],
        [2.8, 55.5],
        [3.6, 59],
        [4.2, 61.5],
        [8.5, 65],
        [12.5, 68],
        [19, 71],
        [30, 71.6],
        [34, 70],
      ],
    ],
    [
      2,
      0.4,
      [
        [-22.6, 63.8],
        [-18, 62],
        [-9, 59.6],
        [-4, 59.3],
        [1, 57.5],
        [3.6, 52.1],
      ],
    ],
    [
      3,
      0.25,
      [
        [5, 37.6],
        [5, 40],
        [4.9, 42.9],
      ],
    ],
    [
      3,
      0.25,
      [
        [5, 37.6],
        [7.2, 41.5],
        [8.6, 43.9],
      ],
    ],
    [
      3,
      0.2,
      [
        [20, 35.2],
        [22.9, 35.9],
        [24.6, 37.6],
        [25.6, 39.3],
        [26.15, 40.02],
        [26.42, 40.2],
        [26.72, 40.42],
        [27.6, 40.72],
        [28.9, 40.95],
        [29.05, 41.1],
        [30.5, 42.8],
        [37, 44.3],
      ],
    ],
    [
      3,
      0.25,
      [
        [14, 36.2],
        [15.7, 36.4],
        [16.9, 37.8],
        [18.75, 39.6],
        [18.9, 40.7],
        [17.4, 42],
        [15, 43.6],
        [13.2, 45],
      ],
    ],
    [
      4,
      0.3,
      [
        [56.6, 26.5],
        [58, 25],
        [60, 22.5],
        [60, 12.2],
      ],
    ],
    [
      3,
      0.25,
      [
        [56.6, 26.5],
        [54, 26.2],
        [51.5, 27.5],
        [49.6, 29.2],
      ],
    ],
    [
      3,
      0.4,
      [
        [-79.75, 9.6],
        [-82, 15],
        [-85.6, 21.7],
        [-89.5, 25.5],
        [-94.3, 28.9],
      ],
    ],
    [
      3,
      0.4,
      [
        [-79.75, 9.6],
        [-76.2, 15],
        [-74, 20],
        [-73.2, 24.5],
        [-73.5, 32],
        [-73.4, 40.1],
      ],
    ],
    [
      2,
      1.6,
      [
        [-52.5, -34.2],
        [-40, -37],
        [-10, -36.5],
        [15.5, -34.5],
      ],
    ],
    [
      2,
      1.6,
      [
        [-45.5, -24.6],
        [-30, -30],
        [0, -34],
        [15.5, -33.5],
      ],
    ],
    [
      2,
      0.4,
      [
        [-70, 40.3],
        [-66.5, 43],
        [-63.3, 44.4],
      ],
    ],
    [
      2,
      0.4,
      [
        [-56, 45.2],
        [-58.5, 47.2],
        [-61.5, 48.4],
      ],
    ],
    [
      2,
      1.0,
      [
        [-60, 20],
        [-58, 13],
        [-50, 6],
        [-44, 0.5],
        [-38.3, -3.3],
      ],
    ],
    [
      2,
      0.3,
      [
        [-10, 43.4],
        [-6, 44.2],
        [-3.2, 43.6],
      ],
    ],
    [
      2,
      0.3,
      [
        [-6.3, 48.4],
        [-6.2, 51.5],
        [-5.4, 53.5],
        [-3.8, 53.6],
      ],
    ],
  ];

  // Anchorages and fishing grounds. [lon, lat, count, spread in degrees]
  const CLUSTERS = [
    [3.2, 52.15, 18, 0.35],
    [-5.3, 36.05, 12, 0.2],
    [32.5, 31.7, 14, 0.3],
    [32.6, 29.6, 10, 0.15],
    [-73.6, 40.25, 10, 0.3],
    [-94.4, 29.0, 16, 0.4],
    [-46.2, -24.3, 12, 0.3],
    [3.3, 6.1, 16, 0.3],
    [56.3, 25.5, 16, 0.4],
    [1.6, 51.2, 8, 0.25],
    [8.2, 54.1, 10, 0.3],
    [-90, 28.4, 12, 0.6],
    [-50, 45.5, 22, 1.4],
    [8, 67, 16, 1.6],
    [30, 72.5, 14, 2],
    [-17.6, 20.5, 20, 1.1],
    [-4.5, 45.6, 14, 1],
    [-24.5, 65.4, 12, 1.2],
    [3, 56.6, 18, 1.4],
    [2, 4.4, 10, 0.8],
    [13, -23, 12, 1.2],
    [-60.5, -45.5, 26, 1.3],
    [-10.5, 51.5, 12, 1.2],
    [-11.5, 30, 12, 1],
    [19, 34, 8, 1],
    [-66, 42.3, 12, 1],
    [-41, -24.5, 10, 0.8],
    [-9.4, 39.5, 8, 0.4],
    [-71, 18, 6, 0.6],
    [-2, 60.8, 10, 1],
  ];

  // Undersea cable routes (approximate; drawn as hairlines).
  const CABLES = [
    [
      [-74, 40],
      [-66, 41.5],
      [-50, 45.5],
      [-30, 50],
      [-12, 50.8],
      [-4.6, 50.8],
    ],
    [
      [-72.6, 40.7],
      [-60, 41.5],
      [-40, 45.5],
      [-20, 47.5],
      [-8, 48.6],
      [-3.5, 48.8],
    ],
    [
      [-76, 36.85],
      [-65, 38.5],
      [-45, 41.5],
      [-25, 43.5],
      [-10, 44],
      [-2.95, 43.45],
    ],
    [
      [-76, 36.85],
      [-62, 39.8],
      [-42, 43.5],
      [-22, 46],
      [-8, 46.8],
      [-1.9, 46.7],
    ],
    [
      [-73.9, 40.1],
      [-64, 43],
      [-52, 47.5],
      [-35, 52],
      [-18, 54],
      [-9.3, 54.2],
    ],
    [
      [-63.6, 44.6],
      [-52, 48.5],
      [-35, 53.5],
      [-18, 55.5],
      [-8.4, 55.2],
    ],
    [
      [-74, 39.5],
      [-70, 36.5],
      [-64.7, 32.35],
    ],
    [
      [-64.7, 32.35],
      [-64.9, 25],
      [-64.9, 18.35],
    ],
    [
      [-80.05, 26.35],
      [-76, 27.2],
      [-70, 23.5],
      [-66, 19.5],
      [-64.8, 17.7],
    ],
    [
      [-64.8, 17.7],
      [-58, 13.5],
      [-50, 7],
      [-43, 0.5],
      [-38.5, -3.7],
    ],
    [
      [-76, 36.85],
      [-71, 30],
      [-67, 22],
      [-66.1, 18.5],
    ],
    [
      [-38.5, -3.7],
      [-33.5, 3],
      [-27, 11],
      [-23.5, 14.9],
      [-20, 24],
      [-17.5, 32],
      [-12, 36.5],
      [-8.9, 37.95],
    ],
    [
      [-38.5, -3.7],
      [-25, -5.5],
      [-5, -8],
      [8, -9],
      [13.2, -8.85],
    ],
    [
      [-38.5, -3.7],
      [-25, -1],
      [-8, 0.5],
      [5, 2],
      [9.9, 2.9],
    ],
    [
      [-38.5, -3.7],
      [-34, -9],
      [-37.5, -16],
      [-40, -22.5],
      [-43.2, -23.1],
    ],
    [
      [-43.2, -23.1],
      [-46, -26.5],
      [-51, -32.5],
      [-56.6, -36.5],
    ],
    [
      [-9.3, 38.5],
      [-11.5, 34],
      [-14.5, 29.6],
      [-18.2, 27],
      [-19, 20],
      [-17.6, 14.7],
    ],
    [
      [-17.6, 14.7],
      [-18, 10],
      [-14, 5.5],
      [-9, 3.2],
      [-4, 4.9],
      [-0.2, 5.4],
      [3.4, 6.2],
    ],
    [
      [3.4, 6.2],
      [4.5, 3],
      [7.5, 0.5],
      [9.5, -4],
      [13, -8.9],
      [11, -17],
      [13.5, -27],
      [18.3, -33.8],
    ],
    [
      [-8.9, 37.95],
      [-8, 36.3],
      [-5.5, 35.95],
      [-1, 36.6],
      [4, 37.8],
      [8.2, 38.2],
      [11.8, 37.3],
      [15.5, 35.8],
      [22, 34.6],
      [28, 32.6],
      [29.9, 31.2],
    ],
    [
      [5.35, 43.2],
      [6.5, 40.5],
      [8.2, 38.2],
    ],
    [
      [15.5, 35.8],
      [17.5, 38.5],
      [18.9, 40.2],
      [16.9, 41.1],
    ],
    [
      [32.55, 29.9],
      [34, 27.3],
      [37.5, 21],
      [41, 15.5],
      [43.3, 12.6],
      [47, 12],
      [54, 14],
      [64, 17],
      [72.8, 19],
    ],
    [
      [-53.3, 47.3],
      [-50.5, 54],
      [-52, 61],
      [-51.7, 64.2],
    ],
    [
      [-51.7, 64.2],
      [-48, 59.5],
      [-38, 60],
      [-28, 62],
      [-20.3, 63.4],
    ],
    [
      [-14, 64.9],
      [-10, 63.5],
      [-6.8, 62],
      [-4.5, 60],
      [-3.4, 58.6],
    ],
    [
      [-20.3, 63.4],
      [-14, 62],
      [-6, 60.6],
      [-2, 59.6],
      [2, 58],
      [8.1, 56.5],
    ],
    [
      [-9.2, 53.2],
      [-12, 55.5],
      [-16, 60],
      [-20.3, 63.4],
    ],
    [
      [16, 68.8],
      [14, 72],
      [13, 76],
      [15.6, 78.2],
    ],
    [
      [-4.6, 50.8],
      [-7, 49.2],
      [-9.5, 45],
      [-10.5, 41],
      [-9.3, 38.5],
    ],
    [
      [-0.2, 5.4],
      [-2, 1],
      [-6, -6],
      [-5.7, -15.9],
    ],
    [
      [-17.6, 14.7],
      [-21, 15.5],
      [-23.5, 14.9],
    ],
  ];

  // [lon, lat, magnitude, hours ago]
  const QUAKES = [
    [25.2, 34.55, 5.2, 0.03],
    [-22.4, 63.85, 3.1, 2.1],
    [-28.3, 38.6, 4.1, 5.5],
    [-33.2, 7.2, 4.8, 9],
    [-8.4, 31.1, 3.9, 14],
    [-66.5, 19.2, 3.6, 3.2],
    [28, 39.2, 4, 7.5],
    [13.2, 42.7, 2.9, 1.4],
    [-44.9, 23.3, 4.6, 18],
    [-8, 71, 3.4, 11],
    [-78.3, 7.3, 4.4, 6],
    [-13.6, -0.9, 4.9, 20],
    [22.1, 38.3, 3.3, 4],
    [-61.3, 15.1, 4.2, 16],
    [35.4, 36.9, 3.8, 9.5],
    [-17.9, 28.6, 2.7, 0.6],
  ];

  const lanePrepared = LANES.map((l) => {
    const pts = l[2].map((p) => vec(p[0], p[1]));
    const seg = [];
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = angle(pts[i], pts[i + 1]);
      seg.push(d);
      total += d;
    }
    return { w: l[0], jitter: l[1], pts, seg, total };
  });

  function buildTraffic() {
    const rnd = mulberry32(20261114);
    const totalW = AIRPORTS.reduce((s, a) => s + a.w, 0);
    const pick = () => {
      let r = rnd() * totalW;
      for (const a of AIRPORTS) {
        r -= a.w;
        if (r <= 0) return a;
      }
      return AIRPORTS[0];
    };
    const aircraft = [];
    while (aircraft.length < 1250) {
      const a = pick();
      const b = pick();
      if (a === b) continue;
      const d = angle(a.v, b.v);
      if (d < 3 * RAD) continue;
      // Short and medium haul dominate; long haul is rarer but each flight is in the air longer.
      const keep = d < 25 * RAD ? 1 : d < 60 * RAD ? 0.4 : 0.18;
      if (rnd() > keep) continue;
      aircraft.push({ a: a.v, b: b.v, d, f: 0.04 + rnd() * 0.92, key: rnd() });
    }

    const ships = [];
    const laneW = lanePrepared.reduce((s, l) => s + l.w * l.total, 0);
    for (let i = 0; i < 420; i++) {
      let r = rnd() * laneW;
      let lane = lanePrepared[0];
      for (const l of lanePrepared) {
        r -= l.w * l.total;
        if (r <= 0) {
          lane = l;
          break;
        }
      }
      let along = rnd() * lane.total;
      let k = 0;
      while (k < lane.seg.length - 1 && along > lane.seg[k]) along -= lane.seg[k++];
      const t = along / lane.seg[k];
      const p = slerp(lane.pts[k], lane.pts[k + 1], t);
      const q = slerp(lane.pts[k], lane.pts[k + 1], Math.min(1, t + 0.02));
      // Narrow the spread near the ends of a segment, where lanes pass straits and headlands.
      const pinch = 0.35 + 0.65 * Math.sin(Math.PI * t);
      const j = lane.jitter * pinch * RAD;
      const off = norm([p[0] + gauss(rnd) * j, p[1] + gauss(rnd) * j, p[2] + gauss(rnd) * j]);
      const off2 = norm([q[0] + (off[0] - p[0]), q[1] + (off[1] - p[1]), q[2] + (off[2] - p[2])]);
      const rev = rnd() < 0.5;
      ships.push({ p: off, q: rev ? null : off2, back: rev ? off2 : null, key: rnd() });
    }
    for (const c of CLUSTERS) {
      for (let i = 0; i < c[2]; i++) {
        const lon = c[0] + (gauss(rnd) * c[3]) / Math.cos(c[1] * RAD);
        const lat = c[1] + gauss(rnd) * c[3];
        const h = rnd() * 360;
        ships.push({
          p: vec(lon, lat),
          q: vec(lon + Math.sin(h * RAD) * 0.2, lat + Math.cos(h * RAD) * 0.2),
          back: null,
          key: rnd(),
        });
      }
    }

    // Low Earth orbit shells. Latitude follows the dwell of a circular inclined orbit.
    const sats = [];
    const shells = [
      [53, 1.086, 0.62],
      [70, 1.09, 0.1],
      [97.6, 1.085, 0.2],
      [43, 1.084, 0.08],
    ];
    for (let i = 0; i < 900; i++) {
      let r = rnd();
      let sh = shells[0];
      for (const s of shells) {
        r -= s[2];
        if (r <= 0) {
          sh = s;
          break;
        }
      }
      const u = rnd() * 2 * Math.PI;
      const lat = Math.asin(Math.sin(sh[0] * RAD) * Math.sin(u)) / RAD;
      sats.push({ v: vec(rnd() * 360 - 180, lat), k: sh[1] + (rnd() - 0.5) * 0.012, key: rnd() });
    }
    return { aircraft, ships, sats };
  }

  const TRAFFIC = buildTraffic();

  /** The space station's orbit as a ring in inertial space; u is the argument of latitude. */
  const ISS = { inc: 51.6 * RAD, node: -59.2 * RAD, u: 20 * RAD, k: 1.066 };
  function issPoint(u) {
    const x = Math.cos(u);
    const y = Math.sin(u) * Math.cos(ISS.inc);
    const z = Math.sin(u) * Math.sin(ISS.inc);
    const c = Math.cos(ISS.node);
    const s = Math.sin(ISS.node);
    return [c * x - s * y, s * x + c * y, z];
  }

  function catmull(points, steps) {
    const out = [];
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(points.length - 1, i + 2)];
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        const t2 = t * t;
        const t3 = t2 * t;
        const c = (a, b, cc, d) =>
          0.5 *
          (2 * b +
            (-a + cc) * t +
            (2 * a - 5 * b + 4 * cc - d) * t2 +
            (-a + 3 * b - 3 * cc + d) * t3);
        out.push([c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])]);
      }
    }
    out.push(points[points.length - 1]);
    return out;
  }
  const CABLE_PATHS = CABLES.map((c) => catmull(c, 10).map((p) => vec(p[0], p[1])));

  /* ---------- world data ---------- */

  let world = null;
  /** Loads coastlines and borders. Resolves to null when offline: the globe still renders, without land. */
  function loadWorld() {
    if (world) return Promise.resolve(world);
    const base = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/";
    const get = (f) =>
      fetch(base + f).then((r) => (r.ok ? r.json() : Promise.reject(new Error(f))));
    return Promise.all([get("land-50m.json"), get("countries-110m.json")])
      .then(([land, countries]) => {
        const t = window.topojson;
        world = {
          land: t.feature(land, land.objects.land),
          borders: t.mesh(countries, countries.objects.countries, (a, b) => a !== b),
        };
        return world;
      })
      .catch(() => null);
  }

  /* ---------- drawing ---------- */

  let lightSprite = null;
  function sprite() {
    if (lightSprite) return lightSprite;
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, "rgba(255,226,180,1)");
    grad.addColorStop(0.25, "rgba(255,217,160,0.7)");
    grad.addColorStop(0.6, "rgba(255,200,130,0.18)");
    grad.addColorStop(1, "rgba(255,190,120,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    lightSprite = c;
    return c;
  }

  /**
   * Paints one frame.
   * opts: { width, height, dpr, lon, lat, radius, cx, cy, anchor: [x, y] | null,
   *         minutesAgo, offline, selected, hover, time }
   * Returns screen anchors for the DOM overlays: { selected, hover, quake }.
   */
  function render(canvas, opts) {
    const dpr = opts.dpr || 1;
    const W = Math.round(opts.width * dpr);
    const H = Math.round(opts.height * dpr);
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    const ctx = canvas.getContext("2d");
    const R = opts.radius;
    const time = opts.time - (opts.minutesAgo || 0) * 60000;
    const on = Object.assign(
      {
        aircraft: true,
        ships: true,
        satellites: true,
        quakes: true,
        cables: true,
        nightlights: true,
      },
      opts.layers,
    );

    // View basis: east, north and outward unit vectors at the centre of the disc.
    const l0 = opts.lon * RAD;
    const p0 = opts.lat * RAD;
    const E = [-Math.sin(l0), Math.cos(l0), 0];
    const N = [-Math.sin(p0) * Math.cos(l0), -Math.sin(p0) * Math.sin(l0), Math.cos(p0)];
    const U = [Math.cos(p0) * Math.cos(l0), Math.cos(p0) * Math.sin(l0), Math.sin(p0)];
    const view = (v) => [dot(v, E), dot(v, N), dot(v, U)];

    const selF = SELECTED.f - ((opts.minutesAgo || 0) * 13.6) / 5540;
    const selPos = slerp(SELECTED.from, SELECTED.to, selF);

    let cx = opts.cx;
    let cy = opts.cy;
    if (opts.anchor) {
      const a = view(selPos);
      cx = opts.anchor[0] - a[0] * R;
      cy = opts.anchor[1] + a[1] * R;
    }
    const project = (v, k) => {
      const q = view(v);
      const kk = k || 1;
      const x = q[0] * kk;
      const y = q[1] * kk;
      const z = q[2] * kk;
      // Hidden when behind the planet and inside its silhouette.
      const visible = z > 0 || x * x + y * y > 1;
      return { x: cx + x * R, y: cy - y * R, z, visible };
    };

    const sunV = view(sunVector(time));
    const daylight = (q) => q[0] * sunV[0] + q[1] * sunV[1] + q[2] * sunV[2];

    /* -- land mask: red = land, green = borders, blue = coast -- */
    const mask = document.createElement("canvas");
    mask.width = W;
    mask.height = H;
    const mctx = mask.getContext("2d", { willReadFrequently: true });
    mctx.fillStyle = "#000";
    mctx.fillRect(0, 0, W, H);
    if (world && window.d3) {
      const proj = window.d3
        .geoOrthographic()
        .rotate([-opts.lon, -opts.lat])
        .translate([cx * dpr, cy * dpr])
        .scale(R * dpr)
        .clipAngle(90)
        .precision(0.3);
      const path = window.d3.geoPath(proj, mctx);
      mctx.fillStyle = "#f00";
      mctx.beginPath();
      path(world.land);
      mctx.fill();
      mctx.globalCompositeOperation = "lighter";
      mctx.lineJoin = "round";
      mctx.strokeStyle = "#00f";
      mctx.lineWidth = 1 * dpr;
      mctx.beginPath();
      path(world.land);
      mctx.stroke();
      mctx.strokeStyle = "#0f0";
      mctx.lineWidth = 0.9 * dpr;
      mctx.beginPath();
      path(world.borders);
      mctx.stroke();
      mctx.globalCompositeOperation = "source-over";
    }
    const md = mctx.getImageData(0, 0, W, H).data;

    /* -- per-pixel planet and atmosphere -- */
    const img = ctx.createImageData(W, H);
    const out = img.data;
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    const Rp = R * dpr;
    const cxp = cx * dpr;
    const cyp = cy * dpr;
    const reach = 1.22;
    const x0 = Math.max(0, Math.floor(cxp - Rp * reach));
    const x1 = Math.min(W - 1, Math.ceil(cxp + Rp * reach));
    const y0 = Math.max(0, Math.floor(cyp - Rp * reach));
    const y1 = Math.min(H - 1, Math.ceil(cyp + Rp * reach));
    const sunPlane = Math.hypot(sunV[0], sunV[1]) || 1;
    for (let py = y0; py <= y1; py++) {
      const y = -(py + 0.5 - cyp) / Rp;
      for (let px = x0; px <= x1; px++) {
        const x = (px + 0.5 - cxp) / Rp;
        const rr = x * x + y * y;
        if (rr > reach * reach) continue;
        const r = Math.sqrt(rr);
        const o = (py * W + px) * 4;
        let cr = 0;
        let cg = 0;
        let cb = 0;
        // How strongly the limb at this bearing is lit by the sun.
        const limbLit =
          0.16 +
          0.84 *
            smooth(-0.55, 0.5, (x * sunV[0] + y * sunV[1]) / (r || 1) / sunPlane + sunV[2] * 0.6);
        if (r < 1) {
          const z = Math.sqrt(1 - rr);
          const d = x * sunV[0] + y * sunV[1] + z * sunV[2];
          const f = on.nightlights ? smooth(-0.13, 0.07, d) : 0.8;
          const land = md[o] / 255;
          const border = md[o + 1] / 255;
          const coast = md[o + 2] / 255;
          const shade = 0.95 + 0.9 * Math.max(d, 0);
          // Day: land #10151c, water #070b11. Night: close to black, land barely lifted.
          const dr = (7 + 9 * land) * shade;
          const dg = (11 + 10 * land) * shade;
          const db = (17 + 11 * land) * shade;
          const nr = 1.5 + 3 * land;
          const ng = 2.2 + 4.2 * land;
          const nb = 3.5 + 6 * land;
          cr = nr + (dr - nr) * f;
          cg = ng + (dg - ng) * f;
          cb = nb + (db - nb) * f;
          const line = border * (0.07 + 0.13 * f) + coast * (1 - border) * (0.035 + 0.055 * f);
          cr += 233 * line;
          cg += 239 * line;
          cb += 246 * line;
          // Warm band along the terminator.
          const band = on.nightlights ? Math.exp(-(((d + 0.02) / 0.075) ** 2)) * 0.03 : 0;
          cr += 255 * band;
          cg += 200 * band;
          cb += 140 * band;
          // Air seen edge-on near the limb.
          const haze =
            Math.pow(1 - z, 3) * (0.05 + 0.3 * f) + Math.exp(-(1 - r) / 0.012) * 0.28 * limbLit;
          cr += RIM[0] * haze;
          cg += RIM[1] * haze;
          cb += RIM[2] * haze;
          // Feather the silhouette by one device pixel.
          const edge = clamp((1 - r) * Rp, 0, 1);
          if (edge < 1) {
            const g = 0.62 * limbLit;
            cr = cr * edge + RIM[0] * g * (1 - edge);
            cg = cg * edge + RIM[1] * g * (1 - edge);
            cb = cb * edge + RIM[2] * g * (1 - edge);
          }
        } else {
          const e = r - 1;
          const g = (Math.exp(-e / 0.011) * 0.62 + Math.exp(-e / 0.05) * 0.1) * limbLit;
          cr = RIM[0] * g;
          cg = RIM[1] * g;
          cb = RIM[2] * g;
        }
        // A little noise so the dark gradients do not band.
        const n = ((Math.sin(px * 12.9898 + py * 78.233) * 43758.5453) % 1) * 0.9;
        out[o] = cr + n;
        out[o + 1] = cg + n;
        out[o + 2] = cb + n;
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.putImageData(img, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    /* -- stars -- */
    const srnd = mulberry32(77);
    const count = Math.round((opts.width * opts.height) / 2600);
    for (let i = 0; i < count; i++) {
      const sx = srnd() * opts.width;
      const sy = srnd() * opts.height;
      const mag = srnd();
      const tint = srnd();
      if (Math.hypot(sx - cx, sy - cy) < R * 1.035) continue;
      const a = 0.1 + mag * mag * mag * 0.75;
      const size = 0.45 + mag * mag * 0.75;
      ctx.fillStyle =
        tint < 0.15
          ? `rgba(255,232,205,${a})`
          : tint > 0.8
            ? `rgba(190,214,255,${a})`
            : `rgba(236,241,248,${a})`;
      ctx.beginPath();
      ctx.arc(sx, sy, size, 0, 7);
      ctx.fill();
    }

    /* -- city lights -- */
    const cities = on.nightlights ? window.HALO_CITIES || [] : [];
    const lrnd = mulberry32(5);
    const zoom = Math.pow(R / 400, 0.75);
    ctx.globalCompositeOperation = "lighter";
    const sp = sprite();
    const light = (v, size, alpha) => {
      const q = view(v);
      if (q[2] <= 0.02) return;
      const night = 1 - smooth(-0.11, 0.03, daylight(q));
      if (night <= 0.01) return;
      const a = alpha * night * (0.35 + 0.65 * q[2]);
      const s = size * zoom;
      ctx.globalAlpha = clamp(a, 0, 1);
      ctx.drawImage(sp, cx + q[0] * R - s, cy - q[1] * R - s, s * 2, s * 2);
    };
    for (let i = 0; i < cities.length; i += 3) {
      const lon = cities[i];
      const lat = cities[i + 1];
      const pop = cities[i + 2];
      const core = clamp(0.9 + 0.2 * Math.pow(pop, 0.36), 1, 4.4);
      light(vec(lon, lat), core, clamp(0.3 + 0.16 * Math.log10(pop), 0.3, 0.95));
      if (pop > 900) light(vec(lon, lat), core * 4.5, 0.1);
      // Sprawl: dimmer points around bigger cities, so regions read as clusters and not dots.
      const extra = Math.min(26, Math.floor(pop / 70));
      const spread = 0.12 + 0.07 * Math.log10(pop + 10);
      for (let k = 0; k < extra; k++) {
        const dx = (gauss(lrnd) * spread * 2.2) / Math.max(0.3, Math.cos(lat * RAD));
        const dy = gauss(lrnd) * spread * 2.2;
        light(vec(lon + dx, lat + dy), 0.9 + lrnd() * 0.7, 0.16 + lrnd() * 0.2);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    const isLand = (x, y) => {
      const px = Math.round(x * dpr);
      const py = Math.round(y * dpr);
      if (px < 0 || py < 0 || px >= W || py >= H) return false;
      return md[(py * W + px) * 4] > 90;
    };
    const onScreen = (p, pad) =>
      p.x > -pad && p.y > -pad && p.x < opts.width + pad && p.y < opts.height + pad;

    const glyph = clamp(Math.pow(R / 400, 0.42), 0.72, 1.3);
    const density = clamp(R / 330, 0.4, 1);

    /* -- undersea cables -- */
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = rgba(ACCENT.cables, 0.5);
    for (const cable of on.cables ? CABLE_PATHS : []) {
      ctx.beginPath();
      let pen = false;
      for (const v of cable) {
        const p = project(v);
        if (p.z <= 0.02) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
        pen = true;
      }
      ctx.stroke();
    }

    /* -- earthquakes -- */
    let quakeAnchor = null;
    (on.quakes ? QUAKES : []).forEach((q, i) => {
      const p = project(vec(q[0], q[1]));
      if (p.z <= 0.05) return;
      const rad = (2 + (q[2] - 2.5) * 2.3) * glyph;
      const fresh = clamp(1 - q[3] / 24, 0.25, 1);
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = rgba(ACCENT.quakes, 0.35 + 0.6 * fresh);
      ctx.beginPath();
      ctx.arc(p.x, p.y, rad, 0, 7);
      ctx.stroke();
      if (i === 0) {
        ctx.fillStyle = rgba(ACCENT.quakes, 0.95);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.4, 0, 7);
        ctx.fill();
        quakeAnchor = { x: p.x, y: p.y, r: rad };
      }
    });

    /* -- ships -- */
    if (!opts.offline && on.ships) {
      ctx.fillStyle = rgba(ACCENT.ships, 0.92);
      const L = 2.6 * glyph;
      const Wd = 1.0 * glyph;
      for (const s of TRAFFIC.ships) {
        if (s.key > density) continue;
        const p = project(s.p);
        if (p.z <= 0.06 || !onScreen(p, 8) || isLand(p.x, p.y)) continue;
        const other = project(s.q || s.back);
        let a = Math.atan2(other.y - p.y, other.x - p.x);
        if (!s.q) a += Math.PI;
        const c = Math.cos(a);
        const sn = Math.sin(a);
        const pt = (lx, ly) => [p.x + lx * c - ly * sn, p.y + lx * sn + ly * c];
        ctx.beginPath();
        let q = pt(L, 0);
        ctx.moveTo(q[0], q[1]);
        q = pt(L * 0.25, Wd);
        ctx.lineTo(q[0], q[1]);
        q = pt(-L, Wd);
        ctx.lineTo(q[0], q[1]);
        q = pt(-L, -Wd);
        ctx.lineTo(q[0], q[1]);
        q = pt(L * 0.25, -Wd);
        ctx.lineTo(q[0], q[1]);
        ctx.closePath();
        ctx.fill();
      }
    }

    /* -- aircraft -- */
    const chevron = (p, a, L, fill) => {
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const pt = (lx, ly) => [p.x + lx * c - ly * sn, p.y + lx * sn + ly * c];
      ctx.fillStyle = fill;
      ctx.beginPath();
      let q = pt(L, 0);
      ctx.moveTo(q[0], q[1]);
      q = pt(-L * 0.8, L * 0.72);
      ctx.lineTo(q[0], q[1]);
      q = pt(-L * 0.36, 0);
      ctx.lineTo(q[0], q[1]);
      q = pt(-L * 0.8, -L * 0.72);
      ctx.lineTo(q[0], q[1]);
      ctx.closePath();
      ctx.fill();
    };
    const tail = (a, b, f, lenRad, alpha) => {
      const dTot = angle(a, b);
      const steps = 5;
      let prev = null;
      for (let i = 0; i <= steps; i++) {
        const ff = f - (lenRad / dTot) * (1 - i / steps);
        const p = project(slerp(a, b, Math.max(0, ff)));
        if (prev && p.z > 0.03 && prev.z > 0.03) {
          ctx.strokeStyle = rgba(ACCENT.aircraft, alpha * (i / steps) * (i / steps));
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
        }
        prev = p;
      }
    };
    let selectedAnchor = null;
    if (!opts.offline && on.aircraft) {
      ctx.lineWidth = 1;
      ctx.lineCap = "butt";
      const L = 2.8 * glyph;
      // With something selected the rest of the layer steps back a little.
      const others = opts.selected ? 0.62 : 0.95;
      const tailLen = (2.0 * RAD) / Math.pow(R / 400, 0.35);
      for (const ac of TRAFFIC.aircraft) {
        if (ac.key > density) continue;
        const f = ac.f - ((opts.minutesAgo || 0) * 13.8) / (ac.d * 6371);
        if (f < 0.01) continue;
        const p = project(slerp(ac.a, ac.b, f));
        if (p.z <= 0.05 || !onScreen(p, 30)) continue;
        tail(ac.a, ac.b, f, tailLen, others * 0.45);
        const ahead = project(slerp(ac.a, ac.b, Math.min(1, f + 0.004)));
        chevron(p, Math.atan2(ahead.y - p.y, ahead.x - p.x), L, rgba(ACCENT.aircraft, others));
      }

      // The selected flight: always drawn so the hit target exists; its track only while selected.
      const p = project(selPos);
      const ahead = project(slerp(SELECTED.from, SELECTED.to, selF + 0.004));
      const heading = Math.atan2(ahead.y - p.y, ahead.x - p.x);
      if (opts.selected) {
        const steps = 70;
        ctx.lineWidth = 1.25;
        let prev = null;
        for (let i = 0; i <= steps; i++) {
          const q = project(slerp(SELECTED.from, SELECTED.to, (selF * i) / steps));
          if (prev && q.z > 0.02 && prev.z > 0.02) {
            ctx.strokeStyle = rgba(ACCENT.aircraft, 0.12 + 0.6 * Math.pow(i / steps, 1.6));
            ctx.beginPath();
            ctx.moveTo(prev.x, prev.y);
            ctx.lineTo(q.x, q.y);
            ctx.stroke();
          }
          prev = q;
        }
        ctx.setLineDash([1.5, 4.5]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = rgba(ACCENT.aircraft, 0.42);
        ctx.beginPath();
        let pen = false;
        for (let i = 0; i <= 40; i++) {
          const q = project(
            slerp(SELECTED.from, SELECTED.to, selF + 0.012 + ((1 - selF - 0.012) * i) / 40),
          );
          if (q.z <= 0.02) {
            pen = false;
            continue;
          }
          if (pen) ctx.lineTo(q.x, q.y);
          else ctx.moveTo(q.x, q.y);
          pen = true;
        }
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        tail(SELECTED.from, SELECTED.to, selF, tailLen, 0.55);
      }
      chevron(
        p,
        heading,
        opts.selected ? L * 1.25 : L,
        opts.selected ? "rgba(214,247,255,1)" : rgba(ACCENT.aircraft, 0.95),
      );
      if (p.z > 0.05) selectedAnchor = { x: p.x, y: p.y, heading: heading / RAD };
    }

    /* -- satellites -- */
    const diamond = (p, h, fill) => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - h);
      ctx.lineTo(p.x + h, p.y);
      ctx.lineTo(p.x, p.y + h);
      ctx.lineTo(p.x - h, p.y);
      ctx.closePath();
      ctx.fill();
    };
    const dh = 2.1 * glyph;
    for (const s of on.satellites ? TRAFFIC.sats : []) {
      if (s.key > density * 0.62) continue;
      const p = project(s.v, s.k);
      if (!p.visible || !onScreen(p, 6)) continue;
      diamond(p, dh, rgba(ACCENT.satellites, p.z > 0 ? 0.85 : 0.5));
    }

    // The space station and its orbit ring, shown for the hovered state.
    let hoverAnchor = null;
    if (on.satellites) {
      const here = project(issPoint(ISS.u), ISS.k);
      if (opts.hover) {
        const steps = 240;
        ctx.lineWidth = 1;
        let prev = null;
        for (let i = 0; i <= steps; i++) {
          const du = (i / steps) * 2 * Math.PI;
          const q = project(issPoint(ISS.u + du), ISS.k);
          if (prev && q.visible && prev.visible) {
            // Brightest just ahead of and behind the station, fading round the far side.
            const near = Math.min(du, 2 * Math.PI - du) / Math.PI;
            ctx.strokeStyle = rgba(ACCENT.satellites, 0.5 - 0.36 * Math.pow(near, 0.6));
            ctx.beginPath();
            ctx.moveTo(prev.x, prev.y);
            ctx.lineTo(q.x, q.y);
            ctx.stroke();
          }
          prev = q;
        }
      }
      if (here.visible) {
        diamond(here, dh * 1.35, opts.hover ? "rgba(226,214,255,1)" : rgba(ACCENT.satellites, 0.9));
        const ahead = project(issPoint(ISS.u + 0.02), ISS.k);
        hoverAnchor = {
          x: here.x,
          y: here.y,
          heading: Math.atan2(ahead.y - here.y, ahead.x - here.x) / RAD,
        };
      }
    }

    return { selected: selectedAnchor, hover: hoverAnchor, quake: quakeAnchor, cx, cy, radius: R };
  }

  /** Debug helper: lists sea-lane sample points that fall on land (run with ?debug). */
  function auditLanes() {
    if (!world || !window.d3) return [];
    const bad = [];
    LANES.forEach((l, li) => {
      const pts = l[2];
      for (let i = 0; i < pts.length - 1; i++) {
        for (let s = 0; s <= 8; s++) {
          const v = slerp(vec(pts[i][0], pts[i][1]), vec(pts[i + 1][0], pts[i + 1][1]), s / 8);
          const lon = Math.atan2(v[1], v[0]) / RAD;
          const lat = Math.asin(v[2]) / RAD;
          if (window.d3.geoContains(world.land, [lon, lat]))
            bad.push(`lane ${li} seg ${i} at ${lon.toFixed(2)},${lat.toFixed(2)}`);
        }
      }
    });
    return bad;
  }

  window.HaloGlobe = { loadWorld, render, auditLanes };
})();
