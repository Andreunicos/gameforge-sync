# GameForge Sync: conta ao app o que esta pessoa tem aberto e selecionado no editor, e o que ela modificou
# e ainda não salvou. O app mostra para a sala (presença) e reserva sozinho o que foi modificado.
# Roda sozinho ao abrir o editor (o init_unreal.py da sala importa este módulo). Só escreve em .gfs/ (não sincroniza).
# O Python do editor não tem evento de "seleção mudou": lê a cada 2 s (custa pouco) e só grava o arquivo quando
# algo muda, mais um sinal de vida a cada 10 s (sem sinal por 30 s o app entende que o editor fechou).
import json
import os
import time

import unreal

_GFS = os.path.join(unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir()), ".gfs")
_OUT = os.path.join(_GFS, "ue-presence.json")
_EVERY = 2.0
_BEAT = 10.0
_MAX = 20  # seleção e modificados: o bastante para mostrar, sem encher a presença
_st = {"next": 0.0, "beat": 0.0, "last": None, "err": False}


def _pkg(obj):
    # Com One File Per Actor o pacote do ator é o arquivo dele em __ExternalActors__ (não o do mapa).
    try:
        return obj.get_package().get_name()
    except Exception:
        return obj.get_outermost().get_name()


def _snapshot():
    world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_selected_level_actors()
    # l = nome que a pessoa vê, p = pacote (arquivo) do ator, n = caminho único do ator (mapa sem OFPA: todos no mesmo pacote)
    sel = [{"l": a.get_actor_label(), "p": _pkg(a), "n": a.get_path_name()} for a in list(actors)[:_MAX]]
    utils = unreal.EditorLoadingAndSavingUtils
    names = set(p.get_name() for p in list(utils.get_dirty_map_packages()) + list(utils.get_dirty_content_packages()))
    # Só o que é do projeto (/Game): plugins e pacotes temporários (/Temp, /Engine) ficam de fora.
    dirty = sorted(n for n in names if n.startswith("/Game/"))
    return {"map": _pkg(world) if world else "", "sel": sel, "dirty": dirty[:_MAX], "more": max(0, len(dirty) - _MAX)}


def _write(data):
    tmp = _OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, _OUT)  # o app nunca lê um arquivo pela metade


def _tick(_dt):
    now = time.time()
    if now < _st["next"]:
        return
    _st["next"] = now + _EVERY
    try:
        snap = _snapshot()
        if snap != _st["last"] or now - _st["beat"] >= _BEAT:
            _write(dict(snap, t=int(now)))
            _st["last"] = snap
            _st["beat"] = now
    except Exception as e:
        if not _st["err"]:  # um aviso só, para não encher o Output Log
            _st["err"] = True
            unreal.log_warning("GameForge Sync (presença): " + str(e))


def _bye():
    try:
        _write({"t": int(time.time()), "off": True})
    except Exception:
        pass


# Só numa pasta de sala do GameForge (tem .gfs); aberto de outro lugar, não faz nada.
if os.path.isdir(_GFS) and not getattr(unreal, "_gameforge_presence", False):
    unreal._gameforge_presence = True  # importado de novo (reload): não registra duas vezes
    unreal.register_slate_post_tick_callback(_tick)
    unreal.register_python_shutdown_callback(_bye)
    unreal.log("GameForge Sync: presença ligada (" + _OUT + ")")
