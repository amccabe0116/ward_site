// Public site configuration. The anon key is safe to publish: the database only
// exposes the roll functions to it (see supabase/schema.sql). Admin actions
// additionally require the passphrase.
//
// Roll classes (Primary, Young Men, Young Women, Sunday School, Elders Quorum,
// Relief Society — whatever your ward uses) are NOT set here. They are configured
// once on the Leaders page (Settings › Roll classes) and stored in the database,
// so a ward can add, rename or remove classes at any time without editing this file.
window.NP_CONFIG = {
  wardName: 'Your Ward',
  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
  supabaseAnonKey: 'YOUR-ANON-KEY',
  timeZone: 'America/New_York',
  // Leaders › Callings: "Refresh from Google Sheets" posts to the Apps Script web app
  // (scripts/announcements.gs → Deploy → Web app). Leave empty until it is deployed.
  sheetsRefreshUrl: '',
  // Community links shown on the home page (leave a value empty to hide it).
  links: {
    facebook: '',
    whatsapp: '',
    // Ward text list: opens a text to this number with the message started for them.
    textList: { number: '', body: 'Please add me to the ward text list. My name is ' },
  },
};
