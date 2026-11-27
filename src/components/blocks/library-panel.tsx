import { createSignal, createEffect, onMount, onCleanup } from "@krate/runtime";
import { openFile } from "@krate/app/dialog";
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
import { PlayerOpen, PlayerPlay, PlayerStream } from "../../../api/player.go";
import { Menu, type MenuItem } from "../ui/menu";
import { Select } from "../ui/select";
import { FoldButton } from "../ui/fold-button";
import { Notice } from "../ui/notice";
import { formatDurationMs } from "../../lib/format";
import { askConfirm, askForm, askText } from "../../lib/modal";
import { splitTags, tagChanges } from "../../lib/tags";
import { setQueue } from "../../lib/queue";
import { pressedCommand } from "../../lib/keymap";
import { panelShown } from "../../lib/workspace";
import { handleError, onRefresh, logFailure, startAudioForUser } from "../../lib/service";
import { currentPrefs, subscribePrefs } from "../../lib/prefs";
import { AudioStream } from "../../../api/audio.go";
import type { ImportProgress, Playlist, Song, TagCount } from "../../lib/types";

const emptyImport: ImportProgress = { running: false, total: 0, done: 0, current: "", errors: [] };

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
  const [loadedId, setLoadedId] = createSignal(0);
  const [loadingId, setLoadingId] = createSignal(0);
  const [thumbs, setThumbs] = createSignal<Record<number, string>>({});
  const [error, setError] = createSignal("");
  const [info, setInfo] = createSignal("");
  const [importing, setImporting] = createSignal<ImportProgress>(emptyImport);
  const [ready, setReady] = createSignal(false);
  const [artwork, setArtwork] = createSignal(true);
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
      logFailure("library load failed", e);
      handleError(e, setError);
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
    if (id && !songs().some((s) => s.id === id)) setSelected(0);
  });

  onMount(() => {
    let appliedSort = "";
    onCleanup(
      subscribePrefs((p) => {
        setArtwork(p.artwork);
        if (p.librarySort !== appliedSort) {
          appliedSort = p.librarySort;
          setSort(p.librarySort);
        }
      }),
    );
    load();
    const off = onRefresh(() => {
      void load();
    });
    onCleanup(off);
    const onKey = (e: KeyboardEvent) => {
      if (!panelShown("library")) return;
      const hit = pressedCommand(e, "workspace", "library");
      if (hit) runLibraryKey(hit.id.split(".")[1]);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  createEffect(() => {
    const song = selectedSong();
    const lists = playlists();
    const inList = playlistId() !== 0;
    const items: MenuItem[] = [
      {
        label: "Load into the player",
        keys: "Enter",
        disabled: !song,
        onSelect: () => (song ? loadSong(song.id) : undefined),
      },
      { label: "Edit details", disabled: !song, onSelect: () => (song ? edit(song.id) : undefined) },
      { label: "", separator: true },
    ];
    for (const p of lists) {
      items.push({ label: "Add to " + p.name, disabled: !song, onSelect: () => addToList(String(p.id)) });
    }
    if (lists.length > 0) items.push({ label: "", separator: true });
    if (inList) {
      items.push({ label: "Move up", disabled: !song, onSelect: () => move(-1) });
      items.push({ label: "Move down", disabled: !song, onSelect: () => move(1) });
      items.push({ label: "Remove from this playlist", disabled: !song, onSelect: () => removeFromList() });
    }
    items.push({ label: "Remove from library", disabled: !song, onSelect: () => forget() });
    items.push({ label: "Delete file from disk", tone: "danger", disabled: !song, onSelect: () => removeSong() });
    setMenuList(items);
  });

  function selectedSong(): Song | undefined {
    return songs().find((s) => s.id === selected());
  }

  function openMenu(e: MouseEvent, id: number) {
    e.preventDefault();
    e.stopPropagation();
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

  function focusSongs() {
    const list = songs();
    if (list.length === 0) return;
    if (!selectedSong()) setSelected(list[0].id);
    (document.querySelector(".library-panel .song-list") as HTMLElement | null)?.focus();
  }

  function songMenuByKey() {
    const row = document.querySelector('[data-song="' + selected() + '"]');
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    const box = row.getBoundingClientRect();
    setMenuX(box.left + 24);
    setMenuY(box.bottom);
    setMenuOpen(true);
  }

  function stepPlaylist(delta: number) {
    const ids = [0].concat(playlists().map((x) => x.id));
    const at = Math.max(0, ids.indexOf(playlistId()));
    setPlaylistId(ids[(at + delta + ids.length) % ids.length]);
  }

  function nextSort() {
    const order = ["added", "title", "artist", "duration"];
    setSort(order[(order.indexOf(sort()) + 1) % order.length]);
  }

  function runLibraryKey(name: string) {
    const actions: Record<string, () => void> = {
      search: () => {
        const box = document.querySelector('.library-panel input[type="search"]') as HTMLInputElement | null;
        box?.focus();
        box?.select();
      },
      list: focusSongs,
      import: () => {
        if (!importing().running) void chooseFiles();
      },
      rescan: () => void rescan(),
      sort: nextSort,
      "list-previous": () => stepPlaylist(-1),
      "list-next": () => stepPlaylist(1),
      "list-new": () => void createList(),
      "list-rename": () => void renameList(),
      "list-delete": () => void deleteList(),
    };
    const onSong: Record<string, () => void> = {
      edit: () => void edit(selected()),
      menu: songMenuByKey,
      up: () => void move(-1),
      down: () => void move(1),
      remove: () => void (playlistId() ? removeFromList() : forget()),
      erase: () => void removeSong(),
    };
    if (actions[name]) {
      actions[name]();
      return;
    }
    if (!selectedSong()) {
      setInfo("Select a song first. Press J, then use the arrow keys.");
      return;
    }
    setInfo("");
    onSong[name]?.();
  }

  async function guard(action: () => Promise<unknown>) {
    setError("");
    try {
      await action();
    } catch (e) {
      logFailure("library action failed", e);
      handleError(e, setError);
    }
  }

  function loadSong(id: number) {
    setSelected(id);
    setLoadingId(id);
    guard(async () => {
      await PlayerOpen(id);
      if (!currentPrefs().playOnLoad) return;
      if (!AudioStream()?.running) await startAudioForUser();
      await PlayerPlay();
    }).finally(() => setLoadingId(0));
  }

  async function edit(id: number) {
    setSelected(id);
    const song = songs().find((x) => x.id === id);
    if (!song) return;
    const before = song.tags || [];
    const values = await askForm({
      title: "Edit song details",
      message: song.path,
      confirmLabel: "Save details",
      fields: [
        { key: "title", label: "Title", value: song.title, required: true },
        { key: "artist", label: "Artist", value: song.artist },
        { key: "album", label: "Album", value: song.album },
        { key: "tags", label: "Tags, separated by commas", value: before.join(", ") },
      ],
    });
    if (!values) return;
    const changes = tagChanges(before, splitTags(values.tags));
    await guard(async () => {
      await SetSongMeta(id, values.title, values.artist, values.album);
      for (const name of changes.removed) await RemoveSongTag(id, name);
      for (const name of changes.added) await AddSongTag(id, name);
    });
  }

  async function chooseFiles() {
    const target = playlistId();
    await guard(async () => {
      const files = await openFile({
        title: "Import songs",
        multiple: true,
        filters: [
          {
            name: "Audio and video",
            patterns: [
              "*.mp3",
              "*.m4a",
              "*.aac",
              "*.flac",
              "*.wav",
              "*.ogg",
              "*.opus",
              "*.mp4",
              "*.mkv",
              "*.webm",
              "*.mov",
            ],
          },
        ],
      });
      if (files && files.length > 0) await ImportFiles(files, target);
    });
  }

  async function rescan() {
    await guard(async () => {
      const res = await RescanLibrary();
      setInfo(
        "Scan finished: " + res.added.length + " added, " + res.updated + " updated, " + res.removed + " removed.",
      );
    });
  }

  async function removeSong() {
    const song = selectedSong();
    if (!song) return;
    const sure = await askConfirm({
      title: "Delete file",
      message: "Delete " + song.title + " and its file from disk? This cannot be undone.",
      confirmLabel: "Delete file",
      danger: true,
    });
    if (!sure) return;
    await guard(async () => {
      await DeleteSong(song.id, true);
      setSelected(0);
    });
  }

  async function forget() {
    const song = selectedSong();
    if (!song) return;
    const sure = await askConfirm({
      title: "Remove from library",
      message: "Remove " + song.title + " from the library? The file stays on disk.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!sure) return;
    await guard(async () => {
      await DeleteSong(song.id, false);
      setSelected(0);
    });
  }

  async function createList() {
    const name = await askText({
      title: "New playlist",
      label: "Playlist name",
      confirmLabel: "Create playlist",
      placeholder: "Warm up",
      maxLength: 60,
    });
    if (!name) return;
    await guard(async () => {
      const made = await CreatePlaylist(name);
      setPlaylistId(made.id);
    });
  }

  async function renameList() {
    const id = playlistId();
    const current = playlists().find((x) => x.id === id);
    if (!current) return;
    const name = await askText({
      title: "Rename playlist",
      label: "Playlist name",
      confirmLabel: "Rename",
      value: current.name,
      maxLength: 60,
    });
    if (!name || name === current.name) return;
    await guard(() => RenamePlaylist(id, name));
  }

  async function deleteList() {
    const id = playlistId();
    const current = playlists().find((x) => x.id === id);
    if (!current) return;
    const sure = await askConfirm({
      title: "Delete playlist",
      message: "Delete the playlist " + current.name + "? The songs stay in your library.",
      confirmLabel: "Delete playlist",
      danger: true,
    });
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
    const id = playlistId();
    if (!song || !id) return;
    const sure = await askConfirm({
      title: "Remove from playlist",
      message: "Remove " + song.title + " from this playlist? It stays in your library.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!sure) return;
    await guard(() => RemoveFromPlaylist(id, song.id));
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
          <button
            class="krate-button krate-button-ghost krate-button-icon krate-button-sm"
            type="button"
            aria-label="Rescan the library folder"
            data-tip="Rescan the library folder"
            data-command="library.rescan"
            onClick={rescan}
          >
            <Icon name="lucide:refresh-cw" />
          </button>
          <button
            class="krate-button krate-button-primary krate-button-sm"
            type="button"
            aria-label="Import songs"
            data-tip={playlistId() ? "Import songs into the open playlist" : "Import songs from files"}
            data-command="library.import"
            disabled={importing().running}
            onClick={chooseFiles}
          >
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
          <Notice
            tone="info"
            title="Importing"
            text={importing().done + " of " + importing().total + ": " + importing().current}
          />
        </div>
        <div showIf={!importing().running && importing().errors.length > 0}>
          <Notice tone="warn" title="Some files were not imported" text={importing().errors.join("; ")} />
        </div>
      </div>

      <div class="lib-toolbar">
        <div class="search-box">
          <Icon name="lucide:search" />
          <input
            class="krate-input"
            type="search"
            placeholder="Search songs, artists, tags"
            aria-label="Search the library"
            value={text()}
            onInput={(e: Event) => setText((e.target as HTMLInputElement).value)}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                e.stopPropagation();
                focusSongs();
              } else if (e.key === "Escape") {
                setText("");
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        </div>
        <div class="narrow-only">
          <Select
            id="lib-playlist"
            label="Playlist"
            value={String(playlistId())}
            options={[{ value: "0", label: "All songs" }].concat(
              playlists().map((p) => ({ value: String(p.id), label: p.name })),
            )}
            onChange={(v) => setPlaylistId(Number(v))}
          />
          <button
            class="krate-button krate-button-ghost krate-button-icon krate-button-sm"
            type="button"
            aria-label="New playlist"
            data-tip="New playlist"
            data-command="library.list-new"
            onClick={createList}
          >
            <Icon name="lucide:list-plus" />
          </button>
          <button
            class="krate-button krate-button-ghost krate-button-icon krate-button-sm"
            type="button"
            aria-label="Rename playlist"
            data-tip="Rename the open playlist"
            data-command="library.list-rename"
            disabled={!playlistId()}
            onClick={renameList}
          >
            <Icon name="lucide:pencil" />
          </button>
          <button
            class="krate-button krate-button-ghost krate-button-icon krate-button-sm"
            type="button"
            aria-label="Delete playlist"
            data-tip="Delete the open playlist"
            data-command="library.list-delete"
            disabled={!playlistId()}
            onClick={deleteList}
          >
            <Icon name="lucide:trash-2" />
          </button>
        </div>
      </div>

      <div class="lib">
        <aside class="lib-rail" aria-label="Playlists and tags">
          <div class="rail-head">
            <span class="rail-title">Playlists</span>
            <button
              class="krate-button krate-button-ghost krate-button-icon krate-button-sm"
              type="button"
              aria-label="New playlist"
              data-tip="New playlist"
              data-command="library.list-new"
              onClick={createList}
            >
              <Icon name="lucide:plus" />
            </button>
            <button
              class="krate-button krate-button-ghost krate-button-icon krate-button-sm"
              type="button"
              aria-label="Rename playlist"
              data-tip="Rename the open playlist"
              data-command="library.list-rename"
              disabled={!playlistId()}
              onClick={renameList}
            >
              <Icon name="lucide:pencil" />
            </button>
            <button
              class="krate-button krate-button-ghost krate-button-icon krate-button-sm"
              type="button"
              aria-label="Delete playlist"
              data-tip="Delete the open playlist"
              data-command="library.list-delete"
              disabled={!playlistId()}
              onClick={deleteList}
            >
              <Icon name="lucide:trash-2" />
            </button>
          </div>
          <button
            class="rail-item"
            type="button"
            data-active={playlistId() === 0 ? "true" : "false"}
            onClick={() => setPlaylistId(0)}
          >
            <span class="rail-label">
              <Icon name="lucide:music" />
              All songs
            </span>
          </button>
          {playlists().map((p) => (
            <button
              class="rail-item"
              type="button"
              key={p.id}
              data-active={playlistId() === p.id ? "true" : "false"}
              onClick={() => setPlaylistId(p.id)}
            >
              <span class="rail-label">
                <Icon name="lucide:list-music" />
                {p.name}
              </span>
              <span class="rail-count">{p.count}</span>
            </button>
          ))}
          <span class="rail-title" showIf={tags().length > 0}>
            Tags
          </span>
          {tags().map((t) => (
            <button
              class="rail-item"
              type="button"
              key={t.name}
              data-active={tag() === t.name ? "true" : "false"}
              onClick={() => setTag(tag() === t.name ? "" : t.name)}
            >
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
            <button
              class="col-head num-head"
              type="button"
              data-sorted={sort() === "added" ? "true" : "false"}
              data-tip="Newest first"
              onClick={() => setSort("added")}
            >
              #
            </button>
            <button
              class="col-head"
              type="button"
              data-sorted={sort() === "title" ? "true" : "false"}
              onClick={() => setSort("title")}
            >
              Title
              <Icon name="lucide:arrow-down" />
            </button>
            <button
              class="col-head col-artist"
              type="button"
              data-sorted={sort() === "artist" ? "true" : "false"}
              onClick={() => setSort("artist")}
            >
              Artist
              <Icon name="lucide:arrow-down" />
            </button>
            <span class="col-head col-album">Album</span>
            <button
              class="col-head num"
              type="button"
              data-sorted={sort() === "duration" ? "true" : "false"}
              data-tip="Longest first"
              onClick={() => setSort("duration")}
            >
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
            <button
              class="krate-button krate-button-primary krate-button-sm"
              type="button"
              disabled={importing().running}
              onClick={chooseFiles}
            >
              <Icon name="lucide:file-plus" />
              Import songs
            </button>
          </div>
          <div class="empty-state" showIf={ready() && songs().length === 0 && (!!text() || !!tag())}>
            <span class="empty-icon">
              <Icon name="lucide:search-x" />
            </span>
            <span class="empty-title">Nothing matches</span>
            <span>Clear the search, tag or playlist to see more songs.</span>
          </div>
          <div class="empty-state" showIf={ready() && songs().length === 0 && !text() && !tag() && !!playlistId()}>
            <span class="empty-icon">
              <Icon name="lucide:list-plus" />
            </span>
            <span class="empty-title">This playlist is empty</span>
            <span>Import songs straight into it, or right-click a song in All songs to add it.</span>
            <button
              class="krate-button krate-button-primary krate-button-sm"
              type="button"
              disabled={importing().running}
              onClick={chooseFiles}
            >
              <Icon name="lucide:file-plus" />
              Import to playlist
            </button>
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
                  <span class="thumb">
                    {artwork() && thumbs()[s.id] ? <img alt="" src={thumbs()[s.id]} /> : <Icon name="lucide:music" />}
                  </span>
                  <span class="song-title">{s.title}</span>
                </span>
                <span class="song-cell song-artist">{s.artist || "Unknown artist"}</span>
                <span class="song-cell song-album">{s.album || ""}</span>
                <span class="song-meta">{formatDurationMs(s.durationMs)}</span>
                <span class="song-actions">
                  <button
                    class="krate-button krate-button-ghost krate-button-icon krate-button-sm"
                    type="button"
                    aria-label={"Edit " + s.title}
                    data-tip="Edit details"
                    onClick={() => edit(s.id)}
                  >
                    <Icon name="lucide:pencil" />
                  </button>
                  <button
                    class="krate-button krate-button-ghost krate-button-icon krate-button-sm"
                    type="button"
                    aria-label={"More actions for " + s.title}
                    data-tip="Add to a playlist, remove or delete"
                    onClick={(e: MouseEvent) => openMenu(e, s.id)}
                  >
                    <Icon name="lucide:ellipsis" />
                  </button>
                  <button
                    class="krate-button krate-button-ghost krate-button-icon krate-button-sm"
                    type="button"
                    aria-label={"Load " + s.title}
                    data-tip="Load into the player"
                    data-keys="Enter"
                    onClick={() => loadSong(s.id)}
                  >
                    <Icon name="lucide:play" />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <Menu
        id="song-menu"
        open={menuOpen()}
        x={menuX()}
        y={menuY()}
        items={menuList()}
        onClose={() => setMenuOpen(false)}
      />
    </section>
  );
}
