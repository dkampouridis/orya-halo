//! The world as a set of overlapping circles, for feeds that answer
//! "aircraft within R of this point" and nothing larger.
//!
//! Circles are laid out in rows of latitude, hex-style: neighbouring rows are
//! offset by half a step. On a sphere the rows cannot stay aligned, so the
//! spacing is tightened by a factor found numerically (0.9 both ways) at which
//! no point on Earth is further than R from a centre.

use crate::model::haversine_km;

const KM_PER_DEGREE: f64 = 111.195;
const KM_PER_NM: f64 = 1.852;
/// Shrink factor on the ideal hex spacing; see the module comment.
const SPACING: f64 = 0.9;

/// Busy airspace, used only to decide which areas a cold start fetches first.
pub(crate) const HUBS: [(f64, f64); 30] = [
    (51.5, -0.5),   // London
    (49.0, 2.5),    // Paris
    (50.0, 8.6),    // Frankfurt
    (52.3, 4.8),    // Amsterdam
    (40.5, -3.6),   // Madrid
    (41.8, 12.2),   // Rome
    (41.3, 28.7),   // Istanbul
    (25.3, 55.4),   // Dubai
    (28.6, 77.1),   // Delhi
    (19.1, 72.9),   // Mumbai
    (1.4, 104.0),   // Singapore
    (13.7, 100.7),  // Bangkok
    (22.3, 113.9),  // Hong Kong
    (31.1, 121.8),  // Shanghai
    (40.1, 116.6),  // Beijing
    (37.5, 126.4),  // Seoul
    (35.6, 139.8),  // Tokyo
    (-33.9, 151.2), // Sydney
    (-26.1, 28.2),  // Johannesburg
    (-23.4, -46.5), // Sao Paulo
    (19.4, -99.1),  // Mexico City
    (33.9, -118.4), // Los Angeles
    (37.6, -122.4), // San Francisco
    (47.4, -122.3), // Seattle
    (39.9, -104.7), // Denver
    (32.9, -97.0),  // Dallas
    (41.98, -87.9), // Chicago
    (33.6, -84.4),  // Atlanta
    (40.6, -73.8),  // New York
    (25.8, -80.3),  // Miami
];

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tile {
    /// Centre, degrees.
    pub lat: f64,
    pub lon: f64,
    /// 0..1: how likely the tile is to hold traffic, before anything is known.
    pub prior: f32,
}

/// Circles of `radius_nm` nautical miles that together cover the whole Earth.
pub fn world_tiles(radius_nm: u32) -> Vec<Tile> {
    let radius_km = f64::from(radius_nm) * KM_PER_NM;
    let radius_deg = radius_km / KM_PER_DEGREE;
    let rows = (180.0 / (1.5 * radius_deg * SPACING)).ceil() as usize;
    let step = 180.0 / rows as f64;
    let mut tiles = Vec::new();
    for i in 0..rows {
        let lat = -90.0 + (i as f64 + 0.5) * step;
        // Space the circles for the longest parallel the row touches.
        let widest = (lat.abs() - step / 2.0).max(0.0);
        let circumference_km = 360.0 * KM_PER_DEGREE * widest.to_radians().cos();
        let n = ((circumference_km / (3f64.sqrt() * radius_km * SPACING)).ceil() as usize).max(1);
        let offset = if i % 2 == 1 { 0.5 } else { 0.0 };
        for j in 0..n {
            let mut lon = -180.0 + (j as f64 + offset) * 360.0 / n as f64;
            if lon >= 180.0 {
                lon -= 360.0;
            }
            let nearest_hub = HUBS
                .iter()
                .map(|(hub_lat, hub_lon)| haversine_km(lat, lon, *hub_lat, *hub_lon))
                .fold(f64::MAX, f64::min);
            tiles.push(Tile { lat, lon, prior: (-nearest_hub / 1500.0).exp() as f32 });
        }
    }
    tiles
}

/// Indexes of the tiles whose circle contains a point.
pub fn tiles_containing(tiles: &[Tile], radius_km: f64, lat: f64, lon: f64) -> Vec<u16> {
    tiles
        .iter()
        .enumerate()
        .filter(|(_, t)| {
            (t.lat - lat).abs() * KM_PER_DEGREE <= radius_km && haversine_km(t.lat, t.lon, lat, lon) <= radius_km
        })
        .map(|(i, _)| i as u16)
        .collect()
}

pub fn radius_km(radius_nm: u32) -> f64 {
    f64::from(radius_nm) * KM_PER_NM
}

#[cfg(test)]
mod tests {
    use h3o::{CellIndex, LatLng, Resolution};

    use super::*;

    #[test]
    fn tiles_cover_the_whole_earth() {
        for radius_nm in [250, 100] {
            let tiles = world_tiles(radius_nm);
            let radius = radius_km(radius_nm);
            // Every resolution-3 cell centre (41,162 points, about 60 km apart)
            // must lie inside some circle. For the smaller radius, sample.
            let stride = if radius_nm == 250 { 1 } else { 7 };
            let mut worst = 0f64;
            for cell in CellIndex::base_cells().flat_map(|c| c.children(Resolution::Three)).step_by(stride) {
                let ll = LatLng::from(cell);
                let nearest = tiles
                    .iter()
                    .filter(|t| (t.lat - ll.lat()).abs() * KM_PER_DEGREE <= radius)
                    .map(|t| haversine_km(t.lat, t.lon, ll.lat(), ll.lng()))
                    .fold(f64::MAX, f64::min);
                worst = worst.max(nearest);
            }
            assert!(worst <= radius, "radius {radius_nm} nm: a point is {worst:.0} km from the nearest centre");
        }
    }

    #[test]
    fn the_250_nm_world_is_about_twelve_hundred_requests() {
        let tiles = world_tiles(250);
        assert!((1100..=1300).contains(&tiles.len()), "{}", tiles.len());
        assert!(tiles.iter().all(|t| (-90.0..=90.0).contains(&t.lat) && (-180.0..180.0).contains(&t.lon)));
        assert!(tiles.iter().all(|t| (0.0..=1.0).contains(&t.prior)));
    }

    #[test]
    fn busy_airspace_ranks_above_empty_ocean() {
        let tiles = world_tiles(250);
        let prior_at = |lat: f64, lon: f64| {
            let i = tiles_containing(&tiles, radius_km(250), lat, lon)[0];
            tiles[usize::from(i)].prior
        };
        assert!(prior_at(51.5, -0.5) > 0.7);
        assert!(prior_at(-50.0, -130.0) < 0.1, "the South Pacific can wait");
        assert!(!tiles_containing(&tiles, radius_km(250), 89.9, 0.0).is_empty());
        assert!(!tiles_containing(&tiles, radius_km(250), 0.0, 179.99).is_empty());
    }
}
