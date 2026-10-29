// Builds Netflix-style category rows (genres, countries, themes) from a full list of
// titles. Works on the item shape the pages use; needs `Genre`, `countries` and
// `keywords` on each item (the Jellyfin adapter provides them).

const MIN_TITLES = 3;
const ROW_SIZE = 20;

const GENRE_LABELS = { 'Science Fiction': 'Sci-Fi', 'TV Movie': 'TV Movies' };

// Production country → adjective. The US is the default, so it doesn't get a row.
const COUNTRY_LABELS = {
  'South Korea': 'Korean', Korea: 'Korean', Japan: 'Japanese', China: 'Chinese', 'Hong Kong': 'Hong Kong',
  Taiwan: 'Taiwanese', India: 'Indian', Thailand: 'Thai', Indonesia: 'Indonesian', Philippines: 'Filipino',
  'United Kingdom': 'British', France: 'French', Germany: 'German', Italy: 'Italian', Spain: 'Spanish',
  Mexico: 'Mexican', Brazil: 'Brazilian', Australia: 'Australian', Canada: 'Canadian', Ireland: 'Irish',
  Sweden: 'Swedish', Denmark: 'Danish', Norway: 'Norwegian', Finland: 'Finnish', Russia: 'Russian', Turkey: 'Turkish',
};

// Themes come from the keywords metadata providers attach to titles; several keywords
// can feed one theme.
const THEMES = [
  ['Revenge', ['revenge', 'waiting for revenge', 'vengeance']],
  ['Anime', ['anime', 'shounen', 'shoujo', 'seinen', 'based on manga', 'anime inspired']],
  ['Martial Arts', ['martial arts', 'kung fu', 'karate']],
  ['Based on a Book', ['based on novel or book', 'based on short story', "based on children's book", 'based on comic', 'based on graphic novel']],
  ['True Stories', ['based on true story', 'biography', 'based on real events']],
  ['Assassins & Hitmen', ['assassin', 'hitman', 'female assassin', 'contract killer']],
  ['Gangsters & Mob', ['gangster', 'mafia', 'organized crime', 'yakuza', 'triad']],
  ['Spies', ['spy', 'female spy', 'spycraft', 'secret agent', 'espionage']],
  ['Kidnappings', ['kidnapping', 'abduction', 'hostage']],
  ['Survival', ['survival', 'fight for survival', 'survival instinct', 'mythic war survival', 'stranded']],
  ['Time Travel', ['time travel', 'time loop', 'time machine']],
  ['Serial Killers', ['serial killer']],
  ['Supernatural', ['supernatural', 'supernatural horror', 'curse', 'ghost', 'haunted house', 'possession', 'demon']],
  ['Dark Comedies', ['dark comedy', 'black comedy']],
  ['Aliens & Space', ['space travel', 'alien', 'aliens', 'alien planet', 'alien attack', 'alien life-form', 'alien technology', 'outer space']],
  ['Superheroes', ['superhero', 'superhero teamup', 'superhero team']],
  ['Heists', ['heist', 'bank robbery', 'robbery']],
  ['Zombies', ['zombie', 'zombie apocalypse']],
  ['End of the World', ['dystopia', 'post-apocalyptic future', 'apocalypse']],
  ['Sports', ['sports', 'boxing', 'football', 'basketball', 'baseball']],
  ['Video Game Adaptations', ['based on video game']],
];

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const byRating = (a, b) => (b.audienceRating ?? 0) - (a.audienceRating ?? 0) || (b.year ?? 0) - (a.year ?? 0);

// Returns every category with enough titles: { key, label, kind, items }.
export function buildCategories(items, { noun = 'Movies' } = {}) {
  const groups = new Map();
  const add = (key, label, kind, item) => {
    if (!groups.has(key)) groups.set(key, { key, label, kind, items: [] });
    const g = groups.get(key);
    if (!g.items.includes(item)) g.items.push(item);
  };
  for (const item of items) {
    for (const { tag } of item.Genre || []) add(`g-${slug(tag)}`, GENRE_LABELS[tag] || tag, 'genre', item);
    // Only the main (first-listed) production country, so co-productions — e.g. a US
    // film animated in Korea — don't land in the wrong country's row.
    const adj = COUNTRY_LABELS[(item.countries || [])[0]];
    if (adj) add(`c-${slug(adj)}`, `${adj} ${noun}`, 'country', item);
    const words = new Set((item.keywords || []).map(k => k.toLowerCase()));
    for (const [label, keys] of THEMES) {
      if (keys.some(k => words.has(k))) add(`t-${slug(label)}`, label, 'theme', item);
    }
  }
  return [...groups.values()]
    .filter(g => g.items.length >= MIN_TITLES)
    .map(g => ({ ...g, items: g.items.sort(byRating) }));
}

// Mixes countries, genres and themes so the page doesn't show ten genre rows in a row.
export function featuredOrder(categories) {
  const of = kind => categories.filter(c => c.kind === kind).sort((a, b) => b.items.length - a.items.length);
  const queues = [of('country'), of('genre'), of('theme')];
  const out = [];
  while (queues.some(q => q.length)) {
    for (const q of queues) if (q.length) out.push(q.shift());
  }
  return out;
}

export const rowItems = category => category.items.slice(0, ROW_SIZE);
