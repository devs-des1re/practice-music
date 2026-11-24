import { createSignal, createEffect, onMount } from "@krate/runtime";
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
} from "../../../api/library.go";
import { PlayerOpen, PlayerStream } from "../../../api/player.go";
import { Field } from "../ui/field";
import { Menu, type MenuItem } from "../ui/menu";
import { Select } from "../ui/select";
import { FoldButton } from "../ui/fold-button";
import { Notice } from "../ui/notice";
import { formatDurationMs } from "../../lib/format";
import { setQueue } from "../../lib/queue";
import { logger } from "../../lib/logger";
import type { ImportProgress, Playlist, Song, TagCount } from "../../lib/types";

const emptyImport: ImportProgress = { running: false, total: 0, done: 0, current: "", errors: [] };

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function LibraryPanel() {
  const [songs, setSongs] = createSignal<Song[]>([]);
  const [tags, setTags] = createSignal<TagCount[]>([]);
  const [playlists, setPlaylists] = createSignal<Playlist[]>([]);
  const [text, setText] = createSignal("");
  const [tag, setTag] = createSignal("");
  const [playlistId, setPlaylistId] = createSignal(0);
  const [sort, setSort] = createSignal("added");
  const [revision, setRevision] = createSignal(0);
  const [selected, setSelected] = createSignal(0);
  const [editing, setEditing] = createSignal(false);
  const [loadedId, setLoadedId] = createSignal(0);
  const [loadingId, setLoadingId] = createSignal(0);
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
  const [ready, setReady] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [menuX, setMenuX] = createSignal(0);
  const [menuY, setMenuY] = createSignal(0);
  const [menuList, setMenuList] = createSignal<MenuItem[]>([]);
  const requested: Record<number, boolean> = {};

  createEffect(() => {
    const next = LibraryRevision();
    if (next !== undefined) setRevision(next);
  });
  createEffect(() => {
    const next = ImportState();
    if (next) setImporting(next);
  });
  createEffect(() => {
    const p = PlayerStream();
    setLoadedId(p && p.loaded ? p.songId : 0);
  });

  async function load() {
    try {
      const query = { text: text(), tag: tag(), playlistId: playlistId(), sort: sort() };
      const list = await Songs(query);
      setSongs(list);
      setQueue(list.map((x) => x.id));
      setReady(true);
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
    if (id && !song) {
      setSelected(0);
      setEditing(false);
    }
    setTitle(song ? song.title : "");
    setArtist(song ? song.artist : "");
    setAlbum(song ? song.album : "");
  });

  onMount(() => {
    load();
  });

  createEffect(() => {
    const song = selectedSong();
    const lists = playlists();
    const inList = playlistId() !== 0;
    const items: MenuItem[] = [
      { label: "Load into the player", keys: "Enter", disabled: !song, onSelect: () => (song ? loadSong(song.id) : undefined) },
      { label: "Edit details", disabled: !song, onSelect: () => (song ? edit(song.id) : undefined) },
      { label: "", separator: true },
    ];
    for (const p of lists) {
      items.push({ label: "Add to " + p.name, disabled: !song, onSelect: () => addToList(String(p.id)) });
    }
    if (lists.length > 0) items.push({ label: "", separator: true });
    if (inList) items.push({ label: "Remove from this playlist", disabled: !song, onSelect: () => removeFromList() });
    items.push({ label: "Remove from library", disabled: !song, onSelect: () => forget() });
    items.push({ label: "Delete file from disk", tone: "danger", disabled: !song, onSelect: () => removeSong() });
    setMenuList(items);
  });

  function selectedSong(): Song | undefined {
    return songs().find((s) => s.id === selected());
  }

  function openMenu(e: MouseEvent, id: number) {
    e.preventDefault();
    setSelected(id);
    setMenuX(e.clientX);
    setMenuY(e.clientY);
    setMenuOpen(true);
  }

  function onListKey(e: KeyboardEvent) {
    const list = songs();
    if (list.length === 0) return;
    const at = list.findIndex((x) => x.id === selected());
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const to = Math.min(list.length - 1, Math.max(0, at < 0 ? 0 : at + (e.key === "ArrowDown" ? 1 : -1)));
      setSelected(list[to].id);
      const row = document.querySelector('[data-song="' + list[to].id + '"]');
      if (row) row.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && at >= 0) {
      e.preventDefault();
      loadSong(list[at].id);
    }
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

  function loadSong(id: number) {
    setSelected(id);
    setLoadingId(id);
    guard(() => PlayerOpen(id)).finally(() => setLoadingId(0));
  }

  function edit(id: number) {
    setSelected(id);
    setEditing(true);
  }

  async function chooseFiles() {
    await guard(async () => {
      const files = await openFile({
        title: "Import songs",
        multiple: true,
        filters: [{ name: "Audio and video", patterns: ["*.mp3", "*.m4a", "*.aac", "*.flac", "*.wav", "*.ogg", "*.opus", "*.mp4", "*.mkv", "*.webm", "*.mov"] }],
      });
      if (files && files.length > 0) await ImportFiles(files);
    });
  }

  async function rescan() {
    await guard(async () => {
      const res = await RescanLibrary();
      setInfo("Scan finished: " + res.added.length + " added, " + res.updated + " updated, " + res.removed + " removed.");
    });
  }

  async function saveMeta() {
    const song = selectedSong();
    if (!song) return;
    await guard(() => SetSongMeta(song.id, title(), artist(), album()));
  }

  async function addTag() {
    const song = selectedSong();
    const name = newTag().trim();
    if (!song || !name) return;
    await guard(async () => {
      await AddSongTag(song.id, name);
      setNewTag("");
    });
  }

  async function removeSong() {
    const song = selectedSong();
    if (!song) return;
    const sure = await confirm("Delete song", "Delete \"" + song.title + "\" and its file from disk? This cannot be undone.");
    if (!sure) return;
    await guard(async () => {
      await DeleteSong(song.id, true);
      setSelected(0);
      setEditing(false);
    });
  }

  async function forget() {
    const song = selectedSong();
    if (!song) return;
    await guard(async () => {
      await DeleteSong(song.id, false);
      setSelected(0);
      setEditing(false);
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
    const song = selectedSong();
    const id = Number(value);
    if (!song || !id) return;
    await guard(() => AddToPlaylist(id, [song.id]));
  }

  async function removeFromList() {
    const song = selectedSong();
    if (!song || !playlistId()) return;
    await guard(() => RemoveFromPlaylist(playlistId(), song.id));
  }

  async function move(delta: number) {
    const song = selectedSong();
    if (!song || !playlistId()) return;
    const index = songs().findIndex((s) => s.id === song.id);
    await guard(() => MoveInPlaylist(playlistId(), song.id, index + delta));
  }

  return (
    <section class="panel ws-panel library-panel" data-panel="library" aria-label="Library">
      <header class="panel-head" data-drag="true">
        <h2 class="panel-title">
          <Icon name="lucide:library-big" />
          Library
          <span class="panel-count">{String(songs().length)}</span>
        </h2>
        <div class="panel-tools">
          <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm" type="button" aria-label="Rescan the library folder" data-tip="Rescan the library folder" onClick={rescan}>
            <Icon name="lucide:refresh-cw" />
          </button>
          <button class="krate-button krate-button-primary krate-button-sm" type="button" aria-label="Import songs" data-tip="Import songs from files" disabled={importing().running} onClick={chooseFiles}>
            <Icon name="lucide:file-plus" />
            Import
          </button>
          <FoldButton />
        </div>
      </header>

      <div class="panel-notices" showIf={!!error() || !!info() || importing().running || importing().errors.length > 0}>
        <div showIf={!!error()}>
          <Notice tone="bad" text={error()} />
        </div>
        <div showIf={!!info() && !error()}>
          <Notice tone="ok" text={info()} />
        </div>
        <div showIf={importing().running}>
          <Notice tone="info" title="Importing" text={importing().done + " of " + importing().total + ": " + importing().current} />
        </div>
        <div showIf={!importing().running && importing().errors.length > 0}>
          <Notice tone="warn" title="Some files were not imported" text={importing().errors.join("; ")} />
        </div>
      </div>

      <div class="lib-toolbar">
        <div class="search-box">
          <Icon name="lucide:search" />
          <input class="krate-input" type="search" placeholder="Search songs, artists, tags" aria-label="Search the library" value={text()} onInput={(e: Event) => setText((e.target as HTMLInputElement).value)} />
        </div>
        <div class="narrow-only">
          <Select
            id="lib-playlist"
            label="Playlist"
            value={String(playlistId())}
            options={[{ value: "0", label: "All songs" }].concat(playlists().map((p) => ({ value: String(p.id), label: p.name })))}
            onChange={(v) => setPlaylistId(Number(v))}
          />
        </div>
      </div>

      <div class="lib" data-editing={editing() ? "true" : "false"}>
        <aside class="lib-rail" aria-label="Playlists and tags">
          <span class="rail-title">Playlists</span>
          <button class="rail-item" type="button" data-active={playlistId() === 0 ? "true" : "false"} onClick={() => setPlaylistId(0)}>
            <span class="rail-label">
              <Icon name="lucide:music" />
              All songs
            </span>
          </button>
          {playlists().map((p) => (
            <button class="rail-item" type="button" key={p.id} data-active={playlistId() === p.id ? "true" : "false"} onClick={() => setPlaylistId(p.id)}>
              <span class="rail-label">
                <Icon name="lucide:list-music" />
                {p.name}
              </span>
              <span class="rail-count">{p.count}</span>
            </button>
          ))}
          <div class="inline-form">
            <input
              class="krate-input"
              type="text"
              placeholder="New playlist"
              aria-label="New playlist name"
              value={newList()}
              onInput={(e: Event) => setNewList((e.target as HTMLInputElement).value)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === "Enter") createList();
              }}
            />
            <button class="krate-button krate-button-secondary krate-button-icon" type="button" aria-label="Create playlist" data-tip="Create playlist" onClick={createList}>
              <Icon name="lucide:plus" />
            </button>
          </div>
          <div class="inline-form" showIf={!!playlistId()}>
            <input
              class="krate-input"
              type="text"
              placeholder="Rename"
              aria-label="Rename playlist"
              value={renameTo()}
              onInput={(e: Event) => setRenameTo((e.target as HTMLInputElement).value)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === "Enter") renameList();
              }}
            />
            <button class="krate-button krate-button-destructive krate-button-icon" type="button" aria-label="Delete playlist" data-tip="Delete this playlist" onClick={deleteList}>
              <Icon name="lucide:trash-2" />
            </button>
          </div>
          <span class="rail-title" showIf={tags().length > 0}>
            Tags
          </span>
          {tags().map((t) => (
            <button class="rail-item" type="button" key={t.name} data-active={tag() === t.name ? "true" : "false"} onClick={() => setTag(tag() === t.name ? "" : t.name)}>
              <span class="rail-label">
                <Icon name="lucide:tag" />
                {t.name}
              </span>
              <span class="rail-count">{t.count}</span>
            </button>
          ))}
        </aside>

        <div class="lib-songs">
          <div class="song-head" role="row">
            <button class="col-head num-head" type="button" data-sorted={sort() === "added" ? "true" : "false"} data-tip="Newest first" onClick={() => setSort("added")}>
              #
            </button>
            <button class="col-head" type="button" data-sorted={sort() === "title" ? "true" : "false"} onClick={() => setSort("title")}>
              Title
              <Icon name="lucide:arrow-down" />
            </button>
            <button class="col-head col-artist" type="button" data-sorted={sort() === "artist" ? "true" : "false"} onClick={() => setSort("artist")}>
              Artist
              <Icon name="lucide:arrow-down" />
            </button>
            <span class="col-head col-album">Album</span>
            <button class="col-head num" type="button" data-sorted={sort() === "duration" ? "true" : "false"} data-tip="Longest first" onClick={() => setSort("duration")}>
              Time
              <Icon name="lucide:arrow-down" />
            </button>
            <span />
          </div>

          <div class="loading-state" data-on={!ready() ? "true" : "false"}>
            <Icon name="lucide:loader" />
            Loading the library
          </div>
          <div class="empty-state" showIf={ready() && songs().length === 0 && !text() && !tag() && !playlistId()}>
            <span class="empty-icon">
              <Icon name="lucide:list-music" />
            </span>
            <span class="empty-title">Your library is empty</span>
            <span>Import audio files or download a song to start practising.</span>
            <button class="krate-button krate-button-primary krate-button-sm" type="button" disabled={importing().running} onClick={chooseFiles}>
              <Icon name="lucide:file-plus" />
              Import songs
            </button>
          </div>
          <div class="empty-state" showIf={ready() && songs().length === 0 && (!!text() || !!tag() || !!playlistId())}>
            <span class="empty-icon">
              <Icon name="lucide:search-x" />
            </span>
            <span class="empty-title">Nothing matches</span>
            <span>Clear the search, tag or playlist to see more songs.</span>
          </div>

          <div class="song-list" tabindex={0} aria-label="Songs" onKeyDown={onListKey}>
            {songs().map((s, i) => (
              <div
                class="song-row"
                key={s.id}
                data-song={String(s.id)}
                data-selected={selected() === s.id ? "true" : "false"}
                data-loaded={loadedId() === s.id ? "true" : "false"}
                data-loading={loadingId() === s.id ? "true" : "false"}
                onClick={() => setSelected(s.id)}
                onDoubleClick={() => loadSong(s.id)}
                onContextMenu={(e: MouseEvent) => openMenu(e, s.id)}
              >
                <span class="song-state">
                  <span class="song-index mono">{String(i + 1)}</span>
                  <Icon name="lucide:audio-lines" />
                </span>
                <span class="song-cell song-title-cell">
                  <span class="thumb">{thumbs()[s.id] ? <img alt="" src={thumbs()[s.id]} /> : <Icon name="lucide:music" />}</span>
                  <span class="song-title">{s.title}</span>
                </span>
                <span class="song-cell song-artist">{s.artist || "Unknown artist"}</span>
                <span class="song-cell song-album">{s.album || ""}</span>
                <span class="song-meta">{formatDurationMs(s.durationMs)}</span>
                <span class="song-actions">
                  <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm" type="button" aria-label={"Edit " + s.title} data-tip="Edit details" onClick={() => edit(s.id)}>
                    <Icon name="lucide:pencil" />
                  </button>
                  <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm" type="button" aria-label={"Load " + s.title} data-tip="Load into the player" data-keys="Enter" onClick={() => loadSong(s.id)}>
                    <Icon name="lucide:play" />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>

        <aside class="lib-details" aria-label="Song details" showIf={editing() && !!selected()}>
          <div class="details-head">
            <span class="setup-title">Details</span>
            <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm" type="button" aria-label="Close details" onClick={() => setEditing(false)}>
              <Icon name="lucide:x" />
            </button>
          </div>
          <div class="details-body">
            <Field label="Title" htmlFor="song-title">
              <input id="song-title" class="krate-input" type="text" value={title()} onInput={(e: Event) => setTitle((e.target as HTMLInputElement).value)} />
            </Field>
            <div class="field-row compact">
              <Field label="Artist" htmlFor="song-artist">
                <input id="song-artist" class="krate-input" type="text" value={artist()} onInput={(e: Event) => setArtist((e.target as HTMLInputElement).value)} />
              </Field>
              <Field label="Album" htmlFor="song-album">
                <input id="song-album" class="krate-input" type="text" value={album()} onInput={(e: Event) => setAlbum((e.target as HTMLInputElement).value)} />
              </Field>
            </div>
            <button class="krate-button krate-button-secondary krate-button-sm" type="button" onClick={saveMeta}>
              <Icon name="lucide:save" />
              Save details
            </button>
            <Field label="Tags" htmlFor="song-new-tag">
              <div class="tag-row">
                {(selectedSong()?.tags || []).map((t) => (
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
                placeholder="Add a tag and press Enter"
                value={newTag()}
                onInput={(e: Event) => setNewTag((e.target as HTMLInputElement).value)}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === "Enter") addTag();
                }}
              />
            </Field>
            <Field label="Playlist" htmlFor="song-add-list">
              <Select
                id="song-add-list"
                value=""
                options={[{ value: "", label: "Add to a playlist" }].concat(playlists().map((p) => ({ value: String(p.id), label: p.name })))}
                onChange={(v) => addToList(v)}
              />
            </Field>
            <div class="detail-actions" showIf={!!playlistId()}>
              <button class="krate-button krate-button-secondary krate-button-icon krate-button-sm" type="button" aria-label="Move up" onClick={() => move(-1)}>
                <Icon name="lucide:arrow-up" />
              </button>
              <button class="krate-button krate-button-secondary krate-button-icon krate-button-sm" type="button" aria-label="Move down" onClick={() => move(1)}>
                <Icon name="lucide:arrow-down" />
              </button>
              <button class="krate-button krate-button-secondary krate-button-sm" type="button" onClick={removeFromList}>
                Remove from playlist
              </button>
            </div>
            <p class="field-hint mono path">{selectedSong()?.path || ""}</p>
            <div class="detail-actions">
              <button class="krate-button krate-button-secondary krate-button-sm" type="button" onClick={forget}>
                Remove from library
              </button>
              <button class="krate-button krate-button-destructive krate-button-sm" type="button" onClick={removeSong}>
                <Icon name="lucide:trash-2" />
                Delete file
              </button>
            </div>
          </div>
        </aside>
      </div>

      <Menu id="song-menu" open={menuOpen()} x={menuX()} y={menuY()} items={menuList()} onClose={() => setMenuOpen(false)} />
    </section>
  );
}
