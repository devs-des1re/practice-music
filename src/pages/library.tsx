import { createSignal, createEffect, onMount, navigate } from "@krate/runtime";
import { openFile, confirm } from "@krate/app/dialog";
import {
  Songs,
  SetSongMeta,
  AddSongTag,
  RemoveSongTag,
  AllTags,
  Playlists,
  CreatePlaylist,
  RenamePlaylist,
  DeletePlaylist,
  AddToPlaylist,
  RemoveFromPlaylist,
  MoveInPlaylist,
  RescanLibrary,
  Thumbnail,
  DeleteSong,
  ImportFiles,
  LibraryRevision,
  ImportState,
} from "../../api/library.go";
import { Panel, PanelHead, PanelBody } from "../components/ui/panel";
import { Field } from "../components/ui/field";
import { Select } from "../components/ui/select";
import { Notice } from "../components/ui/notice";
import { formatDurationMs } from "../lib/format";
import { logger } from "../lib/logger";
import type { ImportProgress, Playlist, Song, TagCount } from "../lib/types";

const SORTS = [
  { value: "added", label: "Newest first" },
  { value: "title", label: "Title" },
  { value: "artist", label: "Artist" },
  { value: "duration", label: "Longest first" },
];

const emptyImport: ImportProgress = { running: false, total: 0, done: 0, current: "", errors: [] };

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function LibraryPage() {
  const [songs, setSongs] = createSignal<Song[]>([]);
  const [tags, setTags] = createSignal<TagCount[]>([]);
  const [playlists, setPlaylists] = createSignal<Playlist[]>([]);
  const [text, setText] = createSignal("");
  const [tag, setTag] = createSignal("");
  const [playlistId, setPlaylistId] = createSignal(0);
  const [sort, setSort] = createSignal("added");
  const [revision, setRevision] = createSignal(0);
  const [selected, setSelected] = createSignal(0);
  const [thumbs, setThumbs] = createSignal<Record<number, string>>({});
  const [error, setError] = createSignal("");
  const [info, setInfo] = createSignal("");
  const [importing, setImporting] = createSignal<ImportProgress>(emptyImport);
  const [title, setTitle] = createSignal("");
  const [artist, setArtist] = createSignal("");
  const [album, setAlbum] = createSignal("");
  const [newTag, setNewTag] = createSignal("");
  const [newList, setNewList] = createSignal("");
  const [renameTo, setRenameTo] = createSignal("");
  const requested: Record<number, boolean> = {};

  createEffect(() => {
    const next = LibraryRevision();
    if (next !== undefined) setRevision(next);
  });
  createEffect(() => {
    const next = ImportState();
    if (next) setImporting(next);
  });

  async function load() {
    try {
      const query = { text: text(), tag: tag(), playlistId: playlistId(), sort: sort() };
      setSongs(await Songs(query));
      setTags(await AllTags());
      setPlaylists(await Playlists());
    } catch (e) {
      logger.error("library load failed", e);
      setError(describe(e));
    }
  }

  createEffect(() => {
    text();
    tag();
    playlistId();
    sort();
    revision();
    load();
  });

  createEffect(() => {
    songs().forEach((s) => {
      if (!s.thumb || requested[s.id]) return;
      requested[s.id] = true;
      Thumbnail(s.id)
        .then((url) => {
          if (url) setThumbs((m) => ({ ...m, [s.id]: url }));
        })
        .catch(() => undefined);
    });
  });

  createEffect(() => {
    const id = selected();
    const song = songs().find((s) => s.id === id);
    if (id && !song) setSelected(0);
    setTitle(song ? song.title : "");
    setArtist(song ? song.artist : "");
    setAlbum(song ? song.album : "");
  });

  onMount(() => {
    load();
  });

  function current(): Song | undefined {
    return songs().find((s) => s.id === selected());
  }

  async function guard(action: () => Promise<unknown>) {
    setError("");
    try {
      await action();
    } catch (e) {
      logger.error("library action failed", e);
      setError(describe(e));
    }
  }

  async function chooseFiles() {
    await guard(async () => {
      const files = await openFile({
        title: "Import songs",
        multiple: true,
        filters: [{ name: "Audio and video", patterns: ["*.mp3", "*.m4a", "*.aac", "*.flac", "*.wav", "*.ogg", "*.opus", "*.mp4", "*.mkv", "*.webm", "*.mov"] }],
      });
      if (files.length > 0) await ImportFiles(files);
    });
  }

  async function rescan() {
    await guard(async () => {
      const res = await RescanLibrary();
      setInfo("Scan finished: " + res.added.length + " added, " + res.updated + " updated, " + res.removed + " removed.");
    });
  }

  async function saveMeta() {
    const song = current();
    if (!song) return;
    await guard(() => SetSongMeta(song.id, title(), artist(), album()));
  }

  async function addTag() {
    const song = current();
    const name = newTag().trim();
    if (!song || !name) return;
    await guard(async () => {
      await AddSongTag(song.id, name);
      setNewTag("");
    });
  }

  async function removeSong() {
    const song = current();
    if (!song) return;
    const sure = await confirm("Delete song", "Delete \"" + song.title + "\" and its file from disk? This cannot be undone.");
    if (!sure) return;
    await guard(async () => {
      await DeleteSong(song.id, true);
      setSelected(0);
    });
  }

  async function forget() {
    const song = current();
    if (!song) return;
    await guard(async () => {
      await DeleteSong(song.id, false);
      setSelected(0);
    });
  }

  async function createList() {
    const name = newList().trim();
    if (!name) return;
    await guard(async () => {
      const made = await CreatePlaylist(name);
      setNewList("");
      setPlaylistId(made.id);
    });
  }

  async function renameList() {
    const name = renameTo().trim();
    if (!playlistId() || !name) return;
    await guard(async () => {
      await RenamePlaylist(playlistId(), name);
      setRenameTo("");
    });
  }

  async function deleteList() {
    const id = playlistId();
    if (!id) return;
    const sure = await confirm("Delete playlist", "Delete this playlist? The songs stay in your library.");
    if (!sure) return;
    await guard(async () => {
      await DeletePlaylist(id);
      setPlaylistId(0);
    });
  }

  async function addToList(value: string) {
    const song = current();
    const id = Number(value);
    if (!song || !id) return;
    await guard(() => AddToPlaylist(id, [song.id]));
  }

  async function removeFromList() {
    const song = current();
    if (!song || !playlistId()) return;
    await guard(() => RemoveFromPlaylist(playlistId(), song.id));
  }

  async function move(delta: number) {
    const song = current();
    if (!song || !playlistId()) return;
    const index = songs().findIndex((s) => s.id === song.id);
    await guard(() => MoveInPlaylist(playlistId(), song.id, index + delta));
  }

  return (
    <main class="page">
      <div class="page-head">
        <div>
          <h1 class="page-title">Library</h1>
          <p class="page-sub">Your songs, tags and playlists.</p>
        </div>
        <div class="actions">
          <button class="krate-button krate-button-secondary" type="button" onClick={rescan}>
            <Icon name="lucide:refresh-cw" />
            Rescan
          </button>
          <button class="krate-button krate-button-primary" type="button" disabled={importing().running} onClick={chooseFiles}>
            <Icon name="lucide:file-plus" />
            Import files
          </button>
        </div>
      </div>

      <div showIf={!!error()}>
        <Notice tone="bad" title="Something went wrong" text={error()} />
      </div>
      <div showIf={!!info()}>
        <Notice tone="ok" title="Library" text={info()} />
      </div>
      <div showIf={importing().running}>
        <Notice tone="info" title="Importing" text={importing().done + " of " + importing().total + ": " + importing().current} />
      </div>
      <div showIf={!importing().running && importing().errors.length > 0}>
        <Notice tone="warn" title="Some files were not imported" text={importing().errors.join("; ")} />
      </div>

      <div class="toolbar">
        <input
          class="krate-input grow"
          type="search"
          placeholder="Search title, artist, album or tag"
          aria-label="Search the library"
          value={text()}
          onInput={(e: Event) => setText((e.target as HTMLInputElement).value)}
        />
        <Select
          id="sort"
          label="Sort"
          value={sort()}
          options={SORTS}
          onChange={(v) => setSort(v)}
        />
        <Select
          id="playlist-filter"
          label="Playlist"
          value={String(playlistId())}
          options={[{ value: "0", label: "All songs" }].concat(playlists().map((p) => ({ value: String(p.id), label: p.name + " (" + p.count + ")" })))}
          onChange={(v) => setPlaylistId(Number(v))}
        />
      </div>

      <div class="tag-row" showIf={tags().length > 0}>
        {tags().map((t) => (
          <button
            class="tag-button"
            type="button"
            key={t.name}
            data-active={tag() === t.name ? "true" : "false"}
            onClick={() => setTag(tag() === t.name ? "" : t.name)}
          >
            {t.name + " " + t.count}
          </button>
        ))}
      </div>

      <div class="grid-2 library-grid">
        <Panel>
          <PanelHead title={playlistId() ? "Playlist" : "Songs"}>
            <span class="muted mono">{songs().length + (songs().length === 1 ? " song" : " songs")}</span>
          </PanelHead>
          <p class="empty" showIf={songs().length === 0}>
            Nothing here yet. Import files, or download songs from the Downloads page.
          </p>
          <div class="song-list">
            {songs().map((s) => (
              <button
                class="song-row"
                type="button"
                key={s.id}
                data-selected={selected() === s.id ? "true" : "false"}
                onClick={() => setSelected(s.id)}
              >
                <span class="thumb">{thumbs()[s.id] ? <img alt="" src={thumbs()[s.id]} /> : <Icon name="lucide:music" />}</span>
                <span class="song-main">
                  <span class="song-title">{s.title}</span>
                  <span class="song-sub">{(s.artist || "Unknown artist") + (s.tags.length > 0 ? "  -  " + s.tags.join(", ") : "")}</span>
                </span>
                <span class="song-meta">
                  <span class="hide-small">{s.kind}</span>
                  <span>{formatDurationMs(s.durationMs)}</span>
                </span>
              </button>
            ))}
          </div>
        </Panel>

        <div class="stack">
          <Panel>
            <PanelHead title="Song" />
            <PanelBody>
              <p class="empty" showIf={!selected()}>
                Select a song to edit its details, tags and playlists.
              </p>
              <div class="stack" showIf={!!selected()}>
                <Field label="Title" htmlFor="song-title">
                  <input id="song-title" class="krate-input" type="text" value={title()} onInput={(e: Event) => setTitle((e.target as HTMLInputElement).value)} />
                </Field>
                <div class="field-row">
                  <Field label="Artist" htmlFor="song-artist">
                    <input id="song-artist" class="krate-input" type="text" value={artist()} onInput={(e: Event) => setArtist((e.target as HTMLInputElement).value)} />
                  </Field>
                  <Field label="Album" htmlFor="song-album">
                    <input id="song-album" class="krate-input" type="text" value={album()} onInput={(e: Event) => setAlbum((e.target as HTMLInputElement).value)} />
                  </Field>
                </div>
                <div class="detail-actions">
                  <button class="krate-button krate-button-primary" type="button" onClick={() => navigate("/player?song=" + selected())}>
                    <Icon name="lucide:play" />
                    Open in player
                  </button>
                  <button class="krate-button krate-button-secondary" type="button" onClick={saveMeta}>
                    Save details
                  </button>
                </div>
                <Field label="Tags" htmlFor="song-new-tag" hint="Press Enter to add a tag, click a tag to remove it.">
                  <div class="tag-row">
                    {(current()?.tags || []).map((t) => (
                      <button class="tag-button" type="button" key={t} aria-label={"Remove tag " + t} onClick={() => guard(() => RemoveSongTag(selected(), t))}>
                        {t}
                        <Icon name="lucide:x" />
                      </button>
                    ))}
                  </div>
                  <input
                    id="song-new-tag"
                    class="krate-input"
                    type="text"
                    placeholder="fills, odd time, warm up"
                    value={newTag()}
                    onInput={(e: Event) => setNewTag((e.target as HTMLInputElement).value)}
                    onKeyDown={(e: KeyboardEvent) => {
                      if (e.key === "Enter") addTag();
                    }}
                  />
                </Field>
                <Field label="Add to playlist" htmlFor="song-add-list">
                  <Select
                    id="song-add-list"
                    value=""
                    options={[{ value: "", label: "Choose a playlist" }].concat(playlists().map((p) => ({ value: String(p.id), label: p.name })))}
                    onChange={(v) => addToList(v)}
                  />
                </Field>
                <div class="detail-actions" showIf={!!playlistId()}>
                  <button class="krate-button krate-button-secondary krate-button-sm" type="button" onClick={() => move(-1)}>
                    <Icon name="lucide:arrow-up" />
                    Move up
                  </button>
                  <button class="krate-button krate-button-secondary krate-button-sm" type="button" onClick={() => move(1)}>
                    <Icon name="lucide:arrow-down" />
                    Move down
                  </button>
                  <button class="krate-button krate-button-secondary krate-button-sm" type="button" onClick={removeFromList}>
                    Remove from playlist
                  </button>
                </div>
                <p class="field-hint mono">{current()?.path || ""}</p>
                <div class="detail-actions">
                  <button class="krate-button krate-button-secondary krate-button-sm" type="button" onClick={forget}>
                    Remove from library
                  </button>
                  <button class="krate-button krate-button-destructive krate-button-sm" type="button" onClick={removeSong}>
                    Delete file
                  </button>
                </div>
              </div>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead title="Playlists" />
            <PanelBody>
              <div class="toolbar">
                <input
                  class="krate-input grow"
                  type="text"
                  placeholder="New playlist name"
                  aria-label="New playlist name"
                  value={newList()}
                  onInput={(e: Event) => setNewList((e.target as HTMLInputElement).value)}
                  onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === "Enter") createList();
                  }}
                />
                <button class="krate-button krate-button-secondary" type="button" onClick={createList}>
                  Create
                </button>
              </div>
              <div class="toolbar" showIf={!!playlistId()}>
                <input
                  class="krate-input grow"
                  type="text"
                  placeholder="Rename the selected playlist"
                  aria-label="Rename playlist"
                  value={renameTo()}
                  onInput={(e: Event) => setRenameTo((e.target as HTMLInputElement).value)}
                />
                <button class="krate-button krate-button-secondary" type="button" onClick={renameList}>
                  Rename
                </button>
                <button class="krate-button krate-button-destructive" type="button" onClick={deleteList}>
                  Delete
                </button>
              </div>
              <p class="field-hint">Pick a playlist in the filter above to see and reorder its songs.</p>
            </PanelBody>
          </Panel>
        </div>
      </div>
    </main>
  );
}
