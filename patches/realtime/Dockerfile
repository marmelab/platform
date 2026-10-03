# Patched Realtime image (patches/realtime/README.md): the upstream image, with the Elixir modules touched by the
# patches recompiled by the release's own Erlang/Elixir and dropped into its lib directory, and the patched
# runtime.exs. Built by build.sh, which fetches the pinned upstream sources and applies the patches (context: src/).
ARG REALTIME_IMAGE=supabase/realtime:v2.134.10
FROM ${REALTIME_IMAGE} AS build
ARG REALTIME_VERSION=2.134.10
COPY src/ /patch/
RUN set -eu; \
    cd /app; \
    mkdir -p /out; \
    find /patch/lib -name '*.ex' | sort > /tmp/files; \
    ./erts-*/bin/erl -noshell -boot "releases/${REALTIME_VERSION}/start_clean" -boot_var RELEASE_LIB /app/lib \
      -pa lib/*/ebin -eval ' \
        {ok, _} = application:ensure_all_started(elixir), \
        {ok, Bin} = file:read_file("/tmp/files"), \
        Files = [F || F <- binary:split(Bin, <<"\n">>, [global, trim_all])], \
        case (list_to_atom("Elixir.Kernel.ParallelCompiler")):compile_to_path(Files, <<"/out">>, \
               [{return_diagnostics, true}]) of \
          {ok, Mods, _} -> \
            {ok, _} = beam_lib:strip_files(filelib:wildcard("/out/*.beam")), \
            io:format("recompiled ~p~n", [Mods]), halt(0); \
          Error -> io:format("~p~n", [Error]), halt(1) \
        end.'; \
    for beam in /out/*.beam; do test -f "lib/realtime-${REALTIME_VERSION}/ebin/$(basename "$beam")"; done

FROM ${REALTIME_IMAGE}
ARG REALTIME_VERSION=2.134.10
COPY --from=build /out/ /app/lib/realtime-${REALTIME_VERSION}/ebin/
COPY src/config/runtime.exs /app/releases/${REALTIME_VERSION}/runtime.exs
LABEL platform.patches="realtime: broadcast changes slot per tenant (SLOT_NAME_PER_TENANT)"
