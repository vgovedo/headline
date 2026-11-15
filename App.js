import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, RefreshControl, Modal,
  TextInput, StyleSheet, Linking, AppState, StatusBar as RNStatusBar,
  ActivityIndicator, Platform, Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const gn = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en&gl=US&ceid=US:en`;

const DEFAULTS = [
  { id: 'bbc', name: 'BBC News', section: 'news', color: '#BB1919', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
  { id: 'sky', name: 'Sky News', section: 'news', color: '#0072C9', url: 'https://feeds.skynews.com/feeds/rss/home.xml' },
  { id: 'cnn', name: 'CNN', section: 'news', color: '#CC0000', url: 'http://rss.cnn.com/rss/edition.rss' },
  { id: 'reuters', name: 'Reuters', section: 'news', color: '#FF8000', url: gn('site:reuters.com when:2d') },
  { id: 'lexpress', name: "L'Express (Mauritius)", section: 'news', color: '#1B5E8C', url: gn('site:lexpress.mu when:7d') },
  { id: 'defi', name: 'Le Defi Media', section: 'news', color: '#D4252A', url: gn('(site:defimedia.info OR site:ledefimedia.mu) when:7d') },
  { id: 'bbcsport', name: 'BBC Sport', section: 'sports', color: '#E0A000', url: 'https://feeds.bbci.co.uk/sport/rss.xml' },
  { id: 'skysports', name: 'Sky Sports', section: 'sports', color: '#0072C9', url: 'https://www.skysports.com/rss/12040' },
  { id: 'soccernet', name: 'Soccernet (ESPN FC)', section: 'sports', color: '#1F8A4C', url: 'https://www.espn.com/espn/rss/soccer/news' },
];

const PALETTE = ['#7A3E9D', '#00796B', '#C2185B', '#455A64', '#EF6C00', '#2E7D32'];
const STORE_KEY = 'channels_v1';
const REFRESH_MS = 30 * 60 * 1000;

const decode = (s = '') =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, ' ').trim();

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
};

function parseFeed(xml) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map((b) => {
    let link = tag(b, 'link');
    if (!link) {
      const m = b.match(/<link[^>]*href="([^"]+)"/i);
      link = m ? m[1] : '';
    }
    return { title: tag(b, 'title'), link, date: tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published') };
  }).filter((i) => i.title && i.link).slice(0, 5);
}

async function loadChannel(ch) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(ch.url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Android) HeadlinesApp/1.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const items = parseFeed(await res.text());
    if (!items.length) throw new Error('No stories found in this feed');
    return { items };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'Timed out' : e.message || 'Could not load' };
  } finally {
    clearTimeout(t);
  }
}

const ago = (d) => {
  const t = Date.parse(d);
  if (!t) return '';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};

export default function App() {
  const [channels, setChannels] = useState(null);
  const [data, setData] = useState({});
  const [tab, setTab] = useState('news');
  const [busy, setBusy] = useState(false);
  const [updated, setUpdated] = useState(null);
  const [manage, setManage] = useState(false);
  const chRef = useRef([]);
  const updatedRef = useRef(0);

  useEffect(() => {
    (async () => {
      let list = DEFAULTS;
      try {
        const raw = await AsyncStorage.getItem(STORE_KEY);
        if (raw) list = JSON.parse(raw);
      } catch (e) {}
      setChannels(list);
    })();
  }, []);

  const refresh = useCallback(async (list) => {
    const target = list || chRef.current;
    if (!target.length) return;
    setBusy(true);
    const results = await Promise.all(target.map(async (c) => [c.id, await loadChannel(c)]));
    setData((prev) => {
      const next = { ...prev };
      results.forEach(([id, r]) => {
        // keep old stories if a refresh fails
        next[id] = r.error && prev[id]?.items ? { items: prev[id].items, error: r.error, stale: true } : r;
      });
      return next;
    });
    const now = Date.now();
    updatedRef.current = now;
    setUpdated(now);
    setBusy(false);
  }, []);

  useEffect(() => {
    if (!channels) return;
    chRef.current = channels;
    AsyncStorage.setItem(STORE_KEY, JSON.stringify(channels)).catch(() => {});
  }, [channels]);

  // first load, then whenever channel list changes load only missing ones
  useEffect(() => {
    if (!channels) return;
    const missing = channels.filter((c) => !data[c.id]);
    if (missing.length) {
      (async () => {
        const results = await Promise.all(missing.map(async (c) => [c.id, await loadChannel(c)]));
        setData((p) => { const n = { ...p }; results.forEach(([id, r]) => (n[id] = r)); return n; });
        setUpdated(Date.now()); updatedRef.current = Date.now();
      })();
    }
  }, [channels]);

  // auto refresh every 30 minutes + when app returns to foreground if stale
  useEffect(() => {
    const iv = setInterval(() => refresh(), REFRESH_MS);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && Date.now() - updatedRef.current > REFRESH_MS) refresh();
    });
    return () => { clearInterval(iv); sub.remove(); };
  }, [refresh]);

  if (!channels) return <View style={s.center}><ActivityIndicator color="#1C2B4A" /></View>;

  const list = channels.filter((c) => c.section === tab);
  const time = updated ? new Date(updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--';

  return (
    <View style={s.root}>
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={s.title}>Headlines</Text>
          <Text style={s.sub}>{busy ? 'Updating…' : `Updated ${time} · refreshes every 30 min`}</Text>
        </View>
        <TouchableOpacity style={s.iconBtn} onPress={() => refresh()}>
          <Text style={s.iconTxt}>Refresh</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.iconBtn, { marginLeft: 8 }]} onPress={() => setManage(true)}>
          <Text style={s.iconTxt}>Channels</Text>
        </TouchableOpacity>
      </View>

      <View style={s.tabs}>
        {[['news', 'News'], ['sports', 'Sports']].map(([k, label]) => (
          <TouchableOpacity key={k} style={[s.tab, tab === k && s.tabOn]} onPress={() => setTab(k)}>
            <Text style={[s.tabTxt, tab === k && s.tabTxtOn]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 14, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={() => refresh()} />}
      >
        {list.length === 0 && (
          <Text style={s.empty}>No channels in this section. Tap Channels to add one.</Text>
        )}
        {list.map((c) => {
          const d = data[c.id];
          return (
            <View key={c.id} style={[s.card, { borderLeftColor: c.color }]}>
              <Text style={[s.chName, { color: c.color }]}>{c.name}</Text>
              {!d && <ActivityIndicator style={{ marginVertical: 12 }} color={c.color} />}
              {d?.error && !d.items && <Text style={s.err}>Couldn't load: {d.error}. Pull down to retry.</Text>}
              {d?.stale && <Text style={s.err}>Showing earlier stories ({d.error}).</Text>}
              {d?.items?.map((it, i) => (
                <TouchableOpacity key={i} style={s.item} onPress={() => Linking.openURL(it.link)}>
                  <Text style={s.itTitle}>{it.title}</Text>
                  {!!ago(it.date) && <Text style={s.itMeta}>{ago(it.date)}</Text>}
                </TouchableOpacity>
              ))}
            </View>
          );
        })}
      </ScrollView>

      <Manage visible={manage} onClose={() => setManage(false)} channels={channels} setChannels={setChannels} />
    </View>
  );
}

function Manage({ visible, onClose, channels, setChannels }) {
  const [name, setName] = useState('');
  const [addr, setAddr] = useState('');
  const [section, setSection] = useState('news');

  const add = () => {
    const a = addr.trim();
    if (!name.trim() || !a) return Alert.alert('Missing details', 'Enter a name and a feed address or website.');
    const isUrl = /^https?:\/\//i.test(a);
    const url = isUrl ? a : gn(`site:${a.replace(/^www\./, '')} when:7d`);
    const ch = {
      id: 'c' + Date.now(), name: name.trim(), section, url,
      color: PALETTE[channels.length % PALETTE.length],
    };
    setChannels([...channels, ch]);
    setName(''); setAddr('');
  };

  const remove = (c) =>
    Alert.alert('Remove channel', `Remove ${c.name}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => setChannels(channels.filter((x) => x.id !== c.id)) },
    ]);

  const reset = () =>
    Alert.alert('Restore defaults', 'Replace your list with the original 9 channels?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Restore', onPress: () => setChannels(DEFAULTS) },
    ]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[s.root, { paddingTop: RNStatusBar.currentHeight || 40 }]}>
        <View style={s.header}>
          <Text style={[s.title, { flex: 1 }]}>Channels</Text>
          <TouchableOpacity style={s.iconBtn} onPress={onClose}><Text style={s.iconTxt}>Done</Text></TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
          <View style={s.card}>
            <Text style={s.chName}>Add a channel</Text>
            <TextInput style={s.input} placeholder="Name (e.g. Al Jazeera)" value={name} onChangeText={setName} />
            <TextInput
              style={s.input} placeholder="Website (aljazeera.com) or RSS link"
              value={addr} onChangeText={setAddr} autoCapitalize="none" autoCorrect={false} keyboardType="url"
            />
            <View style={s.tabs}>
              {[['news', 'News'], ['sports', 'Sports']].map(([k, l]) => (
                <TouchableOpacity key={k} style={[s.tab, section === k && s.tabOn]} onPress={() => setSection(k)}>
                  <Text style={[s.tabTxt, section === k && s.tabTxtOn]}>{l}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={s.primary} onPress={add}><Text style={s.primaryTxt}>Add channel</Text></TouchableOpacity>
          </View>

          {['news', 'sports'].map((sec) => (
            <View key={sec} style={s.card}>
              <Text style={s.chName}>{sec === 'news' ? 'News' : 'Sports'}</Text>
              {channels.filter((c) => c.section === sec).map((c) => (
                <View key={c.id} style={s.row}>
                  <View style={[s.dot, { backgroundColor: c.color }]} />
                  <Text style={{ flex: 1, fontSize: 15, color: '#1C2B4A' }}>{c.name}</Text>
                  <TouchableOpacity onPress={() => remove(c)}><Text style={s.remove}>Remove</Text></TouchableOpacity>
                </View>
              ))}
            </View>
          ))}
          <TouchableOpacity onPress={reset} style={{ alignSelf: 'center', padding: 12 }}>
            <Text style={s.remove}>Restore default channels</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    </Modal>
  );
}

const INK = '#1C2B4A';
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F3F1EC', paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight : 44 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  title: { fontSize: 28, fontWeight: '800', color: INK },
  sub: { fontSize: 12, color: '#6B7487', marginTop: 2 },
  iconBtn: { backgroundColor: INK, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  iconTxt: { color: '#fff', fontSize: 13, fontWeight: '600' },
  tabs: { flexDirection: 'row', marginHorizontal: 14, backgroundColor: '#E4E1D8', borderRadius: 10, padding: 3, marginBottom: 4 },
  tab: { flex: 1, paddingVertical: 9, alignItems: 'center', borderRadius: 8 },
  tabOn: { backgroundColor: '#fff' },
  tabTxt: { fontSize: 15, color: '#6B7487', fontWeight: '600' },
  tabTxtOn: { color: INK },
  card: { backgroundColor: '#fff', borderRadius: 10, padding: 14, marginBottom: 14, borderLeftWidth: 5, borderLeftColor: INK },
  chName: { fontSize: 17, fontWeight: '800', marginBottom: 6, color: INK },
  item: { paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#D9D6CC' },
  itTitle: { fontSize: 15, lineHeight: 21, color: '#1A1A1A' },
  itMeta: { fontSize: 12, color: '#8A90A0', marginTop: 3 },
  err: { color: '#9A3412', fontSize: 13, marginVertical: 6 },
  empty: { textAlign: 'center', color: '#6B7487', marginTop: 40, fontSize: 15 },
  input: { borderWidth: 1, borderColor: '#CFCBBF', borderRadius: 8, padding: 10, marginVertical: 6, fontSize: 15, backgroundColor: '#FBFAF7' },
  primary: { backgroundColor: INK, borderRadius: 8, padding: 12, alignItems: 'center', marginTop: 10 },
  primaryTxt: { color: '#fff', fontWeight: '700', fontSize: 15 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#D9D6CC' },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 10 },
  remove: { color: '#B42318', fontWeight: '600', fontSize: 14 },
});
