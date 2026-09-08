#!/usr/bin/env bash

readonly ATTACHED_CLI_UNAVAILABLE=10
readonly ATTACHED_CLI_UNSAFE=11
readonly ATTACHED_CLI_MISMATCH=12

attached_cli_effective_uid() {
    command id -u 2>/dev/null
}

attached_cli_canonical_executable() {
    command readlink -e -- "$1" 2>/dev/null
}

attached_cli_filesystem_metadata() {
    local target=$1 metadata kind link=

    metadata=$(LC_ALL=C command stat -c $'%F\t%a\t%u\t%d\t%i' -- "$target" 2>/dev/null) ||
        return 1
    kind=${metadata%%$'\t'*}
    if [[ $kind == "symbolic link" ]]; then
        link=$(command readlink -- "$target" 2>/dev/null) || return 1
    fi
    printf '%s\t%s\n' "$metadata" "$link"
}

attached_cli_read_metadata() {
    local target=$1 metadata rest tabs=0

    metadata=$(attached_cli_filesystem_metadata "$target" 2>/dev/null) || return "$ATTACHED_CLI_UNAVAILABLE"
    [[ $metadata != *$'\n'* ]] || return "$ATTACHED_CLI_UNSAFE"
    rest=$metadata
    while [[ $rest == *$'\t'* ]]; do
        rest=${rest#*$'\t'}
        ((tabs += 1))
    done
    ((tabs == 5)) || return "$ATTACHED_CLI_UNSAFE"

    IFS=$'\t' read -r ATTACHED_CLI_META_KIND ATTACHED_CLI_META_MODE \
        ATTACHED_CLI_META_UID ATTACHED_CLI_META_DEV ATTACHED_CLI_META_INODE \
        ATTACHED_CLI_META_LINK <<<"$metadata"
    [[ $ATTACHED_CLI_META_MODE =~ ^[0-7]+$ &&
        $ATTACHED_CLI_META_UID =~ ^[0-9]+$ &&
        $ATTACHED_CLI_META_DEV =~ ^[0-9]+$ &&
        $ATTACHED_CLI_META_INODE =~ ^[0-9]+$ ]] || return "$ATTACHED_CLI_UNSAFE"
    ATTACHED_CLI_META_RAW=$metadata
}

attached_cli_require_metadata() {
    local target=$1 expected_kind=$2 expected_mode=$3 expected_uid=$4

    attached_cli_read_metadata "$target" || return
    [[ $ATTACHED_CLI_META_KIND == "$expected_kind" &&
        $ATTACHED_CLI_META_MODE == "$expected_mode" &&
        $ATTACHED_CLI_META_UID == "$expected_uid" &&
        -z $ATTACHED_CLI_META_LINK ]] || return "$ATTACHED_CLI_UNSAFE"
}

attached_cli_read_lines() {
    local target=$1 line

    ATTACHED_CLI_LINES=()
    if IFS= read -r -d '' _ 2>/dev/null <"$target"; then
        return "$ATTACHED_CLI_UNSAFE"
    fi
    while IFS= read -r line; do
        ATTACHED_CLI_LINES+=("$line")
    done 2>/dev/null <"$target" || return "$ATTACHED_CLI_UNAVAILABLE"
    [[ -z $line ]] || return "$ATTACHED_CLI_UNSAFE"
}

attached_cli_snapshot_append() {
    local encoded

    printf -v encoded '%q' "$1"
    ATTACHED_CLI_SNAPSHOT_BUILD+="|${#encoded}:$encoded"
}

attached_cli_read_single_line() {
    local target=$1 descriptor

    if ! { exec {descriptor}<"$target"; } 2>/dev/null; then
        return "$ATTACHED_CLI_UNAVAILABLE"
    fi
    if ! IFS= read -r ATTACHED_CLI_LINE <&"$descriptor"; then
        exec {descriptor}<&-
        return "$ATTACHED_CLI_UNAVAILABLE"
    fi
    if IFS= read -r _ <&"$descriptor"; then
        exec {descriptor}<&-
        return "$ATTACHED_CLI_UNSAFE"
    fi
    exec {descriptor}<&-
}

attached_cli_read_process() {
    local proc_root=$1 pid=$2 expected_start=$3 expected_parent=$4 expected_executable=$5 uid=$6
    local process_dir=$proc_root/$pid stat_path=$proc_root/$pid/stat exe_path=$proc_root/$pid/exe
    local stat_metadata stat_line stat_rest stat_pid state parent start fields

    attached_cli_require_metadata "$process_dir" directory 555 "$uid" || return
    attached_cli_snapshot_append "$ATTACHED_CLI_META_RAW"
    attached_cli_read_metadata "$stat_path" || return
    [[ ($ATTACHED_CLI_META_KIND == "regular file" ||
        $ATTACHED_CLI_META_KIND == "regular empty file") &&
        $ATTACHED_CLI_META_MODE == 444 &&
        $ATTACHED_CLI_META_UID == "$uid" &&
        -z $ATTACHED_CLI_META_LINK ]] || return "$ATTACHED_CLI_UNSAFE"
    stat_metadata=$ATTACHED_CLI_META_RAW
    attached_cli_read_single_line "$stat_path" || return
    stat_line=$ATTACHED_CLI_LINE
    stat_pid=${stat_line%% *}
    stat_rest=${stat_line##*) }
    [[ $stat_pid == "$pid" && $stat_rest != "$stat_line" ]] || return "$ATTACHED_CLI_UNSAFE"
    read -r -a fields <<<"$stat_rest"
    ((${#fields[@]} >= 20)) || return "$ATTACHED_CLI_UNSAFE"
    state=${fields[0]}
    parent=${fields[1]}
    start=${fields[19]}
    [[ $state =~ ^[^[:space:]]$ && $parent =~ ^[0-9]+$ && $start =~ ^[0-9]+$ ]] ||
        return "$ATTACHED_CLI_UNSAFE"
    [[ $state != Z ]] || return "$ATTACHED_CLI_UNAVAILABLE"
    [[ $start == "$expected_start" ]] || return "$ATTACHED_CLI_MISMATCH"
    if [[ -n $expected_parent && $parent != "$expected_parent" ]]; then
        return "$ATTACHED_CLI_MISMATCH"
    fi
    attached_cli_read_metadata "$stat_path" || return
    [[ $ATTACHED_CLI_META_RAW == "$stat_metadata" ]] || return "$ATTACHED_CLI_UNSAFE"

    attached_cli_read_metadata "$exe_path" || return
    [[ $ATTACHED_CLI_META_KIND == "symbolic link" &&
        $ATTACHED_CLI_META_MODE == 777 &&
        $ATTACHED_CLI_META_UID == "$uid" &&
        -n $ATTACHED_CLI_META_LINK ]] || return "$ATTACHED_CLI_UNSAFE"
    [[ $ATTACHED_CLI_META_LINK == "$expected_executable" &&
        $exe_path -ef $expected_executable ]] || return "$ATTACHED_CLI_MISMATCH"
    attached_cli_snapshot_append "$stat_metadata"
    # CPU accounting and scheduling state can change without changing identity.
    # Liveness and expected identity are still checked on every snapshot above.
    attached_cli_snapshot_append "$stat_pid:$parent:$start"
    attached_cli_snapshot_append "$ATTACHED_CLI_META_RAW"
}

attached_cli_read_authority_command() {
    local proc_root=$1 pid=$2 expected_executable=$3 socket=$4 uid=$5
    local cmdline_path=$proc_root/$pid/cmdline cmdline_metadata argument='' index

    attached_cli_read_metadata "$cmdline_path" || return
    [[ ($ATTACHED_CLI_META_KIND == "regular file" ||
        $ATTACHED_CLI_META_KIND == "regular empty file") &&
        $ATTACHED_CLI_META_MODE == 444 &&
        $ATTACHED_CLI_META_UID == "$uid" &&
        -z $ATTACHED_CLI_META_LINK ]] || return "$ATTACHED_CLI_UNSAFE"
    cmdline_metadata=$ATTACHED_CLI_META_RAW
    ATTACHED_CLI_ARGV=()
    while IFS= read -r -d '' argument; do
        ATTACHED_CLI_ARGV+=("$argument")
    done 2>/dev/null <"$cmdline_path" || return "$ATTACHED_CLI_UNAVAILABLE"
    [[ -z $argument && ${#ATTACHED_CLI_ARGV[@]} -gt 0 ]] || return "$ATTACHED_CLI_UNSAFE"
    attached_cli_read_metadata "$cmdline_path" || return
    [[ $ATTACHED_CLI_META_RAW == "$cmdline_metadata" ]] || return "$ATTACHED_CLI_UNSAFE"

    [[ ${ATTACHED_CLI_ARGV[0]} == "$expected_executable" ]] || return "$ATTACHED_CLI_MISMATCH"
    index=1
    while ((index < ${#ATTACHED_CLI_ARGV[@]})) && [[ ${ATTACHED_CLI_ARGV[index]} == -c ]]; do
        ((index + 1 < ${#ATTACHED_CLI_ARGV[@]})) || return "$ATTACHED_CLI_MISMATCH"
        ((index += 2))
    done
    ((index + 3 == ${#ATTACHED_CLI_ARGV[@]})) || return "$ATTACHED_CLI_MISMATCH"
    [[ ${ATTACHED_CLI_ARGV[index]} == app-server &&
        ${ATTACHED_CLI_ARGV[index + 1]} == --listen &&
        ${ATTACHED_CLI_ARGV[index + 2]} == "unix://$socket" ]] ||
        return "$ATTACHED_CLI_MISMATCH"
    attached_cli_snapshot_append "$cmdline_metadata"
    for argument in "${ATTACHED_CLI_ARGV[@]}"; do
        attached_cli_snapshot_append "$argument"
    done
}

attached_cli_read_listener() {
    local proc_root=$1 authority_pid=$2 socket=$3 uid=$4
    local table=$proc_root/net/unix table_contents line number ref_count protocol flags type state inode unix_path
    local listener_inode='' fd_dir fd_path fd_count=0

    [[ -r $table ]] || return "$ATTACHED_CLI_UNAVAILABLE"
    # Buffer proc's changing seq_file before parsing instead of reading it a byte
    # at a time in Bash. This narrows the read window; it is not an atomic snapshot.
    table_contents=$(<"$table") || return "$ATTACHED_CLI_UNAVAILABLE"
    while IFS= read -r line || [[ -n $line ]]; do
        read -r number ref_count protocol flags type state inode unix_path <<<"$line"
        if [[ $unix_path == "$socket" ]]; then
            [[ $number == *: && $ref_count =~ ^[0-9A-Fa-f]+$ &&
                $protocol =~ ^[0-9A-Fa-f]+$ && $flags =~ ^[0-9A-Fa-f]+$ &&
                $type =~ ^[0-9A-Fa-f]+$ && $state =~ ^[0-9A-Fa-f]+$ &&
                $inode =~ ^[1-9][0-9]*$ ]] ||
                return "$ATTACHED_CLI_UNSAFE"
            # Accepted stream connections retain the listening socket's pathname.
            if [[ $flags == 00000000 && $type == 0001 && $state == 03 ]]; then
                continue
            fi
            [[ $flags == 00010000 && $type == 0001 && $state == 01 ]] ||
                return "$ATTACHED_CLI_MISMATCH"
            # Concurrent socket churn can repeat a row. Only distinct listener
            # inodes represent conflicting authorities.
            [[ -z $listener_inode || $listener_inode == "$inode" ]] ||
                return "$ATTACHED_CLI_MISMATCH"
            listener_inode=$inode
        fi
    done <<<"$table_contents"
    [[ -n $listener_inode ]] || return "$ATTACHED_CLI_UNAVAILABLE"

    fd_dir=$proc_root/$authority_pid/fd
    attached_cli_require_metadata "$fd_dir" directory 500 "$uid" || return
    attached_cli_snapshot_append "$ATTACHED_CLI_META_RAW"
    for fd_path in "$fd_dir"/*; do
        [[ -e $fd_path || -L $fd_path ]] || continue
        attached_cli_read_metadata "$fd_path" || return
        # Proc FD-link permissions reflect descriptor access (O_PATH/read/write),
        # unlike the FD directory's fixed mode 500.
        [[ $ATTACHED_CLI_META_KIND == "symbolic link" &&
            $ATTACHED_CLI_META_MODE =~ ^[1357]00$ &&
            $ATTACHED_CLI_META_UID == "$uid" &&
            -n $ATTACHED_CLI_META_LINK ]] || return "$ATTACHED_CLI_UNSAFE"
        if [[ $ATTACHED_CLI_META_LINK == "socket:[$listener_inode]" ]]; then
            ((fd_count += 1))
        fi
    done
    ((fd_count > 0)) || return "$ATTACHED_CLI_MISMATCH"
    attached_cli_snapshot_append "$listener_inode"
}

attached_cli_snapshot() {
    local record_dir=$1 proc_root=$2 record_path uid expected_app socket desktop codex
    local lock_path socket_parent record_metadata lock_metadata owner_pid owner_start
    local authority_pid authority_start canonical_codex codex_metadata canonical_metadata

    unset ATTACHED_CLI_SNAPSHOT
    unset ATTACHED_CLI_VERIFIED_CODEX ATTACHED_CLI_VERIFIED_SOCKET
    ATTACHED_CLI_SNAPSHOT_BUILD=v1
    uid=$(attached_cli_effective_uid 2>/dev/null) || return "$ATTACHED_CLI_UNSAFE"
    [[ $uid =~ ^[0-9]+$ ]] || return "$ATTACHED_CLI_UNSAFE"
    [[ $record_dir == /*/app-server-bridge && $record_dir != */ ]] || return "$ATTACHED_CLI_UNSAFE"
    expected_app=${record_dir%/app-server-bridge}
    expected_app=${expected_app##*/}
    [[ -n $expected_app && $expected_app != */* ]] || return "$ATTACHED_CLI_UNSAFE"

    attached_cli_require_metadata "$record_dir" directory 700 "$uid" || return
    attached_cli_snapshot_append "$ATTACHED_CLI_META_RAW"
    record_path=$record_dir/attached-cli-v1
    attached_cli_require_metadata "$record_path" "regular file" 600 "$uid" || return
    record_metadata=$ATTACHED_CLI_META_RAW
    attached_cli_read_lines "$record_path" || return
    ((${#ATTACHED_CLI_LINES[@]} == 5)) || return "$ATTACHED_CLI_UNSAFE"
    [[ ${ATTACHED_CLI_LINES[0]} == version=1 &&
        ${ATTACHED_CLI_LINES[1]} == app_id=* &&
        ${ATTACHED_CLI_LINES[2]} == socket=* &&
        ${ATTACHED_CLI_LINES[3]} == desktop=* &&
        ${ATTACHED_CLI_LINES[4]} == codex=* ]] || return "$ATTACHED_CLI_UNSAFE"
    [[ ${ATTACHED_CLI_LINES[1]} == "app_id=$expected_app" ]] || return "$ATTACHED_CLI_UNSAFE"
    socket=${ATTACHED_CLI_LINES[2]#socket=}
    desktop=${ATTACHED_CLI_LINES[3]#desktop=}
    codex=${ATTACHED_CLI_LINES[4]#codex=}
    [[ $socket == /* && $desktop == /* && $codex == /* ]] || return "$ATTACHED_CLI_UNSAFE"
    attached_cli_require_metadata "$record_path" "regular file" 600 "$uid" || return
    [[ $ATTACHED_CLI_META_RAW == "$record_metadata" ]] || return "$ATTACHED_CLI_UNSAFE"
    attached_cli_snapshot_append "$record_metadata"
    attached_cli_snapshot_append "${ATTACHED_CLI_LINES[*]}"

    # Keep the selected path for argv[0], but bind execution to its current target.
    # A Nix bin/codex symlink differs from the kernel's canonical /proc/PID/exe.
    attached_cli_read_metadata "$codex" || return
    codex_metadata=$ATTACHED_CLI_META_RAW
    canonical_codex=$(attached_cli_canonical_executable "$codex") || return "$ATTACHED_CLI_UNAVAILABLE"
    [[ $canonical_codex == /* && $canonical_codex != *$'\n'* &&
        -f $canonical_codex && -x $canonical_codex ]] || return "$ATTACHED_CLI_UNSAFE"
    attached_cli_read_metadata "$canonical_codex" || return
    canonical_metadata=$ATTACHED_CLI_META_RAW
    attached_cli_snapshot_append "$codex_metadata"
    attached_cli_snapshot_append "$canonical_codex"
    attached_cli_snapshot_append "$canonical_metadata"

    socket_parent=${socket%/*}
    [[ -n $socket_parent && $socket_parent != "$socket" ]] || return "$ATTACHED_CLI_UNSAFE"
    attached_cli_require_metadata "$socket_parent" directory 700 "$uid" || return
    attached_cli_snapshot_append "$ATTACHED_CLI_META_RAW"
    attached_cli_require_metadata "$socket" socket 600 "$uid" || return
    attached_cli_snapshot_append "$ATTACHED_CLI_META_RAW"

    lock_path=$socket.lock
    attached_cli_require_metadata "$lock_path" "regular file" 600 "$uid" || return
    lock_metadata=$ATTACHED_CLI_META_RAW
    attached_cli_read_lines "$lock_path" || return
    ((${#ATTACHED_CLI_LINES[@]} == 1)) || return "$ATTACHED_CLI_UNSAFE"
    [[ ${ATTACHED_CLI_LINES[0]} =~ ^([1-9][0-9]*)\ ([1-9][0-9]*)\ ([1-9][0-9]*)\ ([1-9][0-9]*)$ ]] ||
        return "$ATTACHED_CLI_UNSAFE"
    owner_pid=${BASH_REMATCH[1]}
    owner_start=${BASH_REMATCH[2]}
    authority_pid=${BASH_REMATCH[3]}
    authority_start=${BASH_REMATCH[4]}
    attached_cli_require_metadata "$lock_path" "regular file" 600 "$uid" || return
    [[ $ATTACHED_CLI_META_RAW == "$lock_metadata" ]] || return "$ATTACHED_CLI_UNSAFE"
    attached_cli_snapshot_append "$lock_metadata"
    attached_cli_snapshot_append "${ATTACHED_CLI_LINES[0]}"

    attached_cli_read_process "$proc_root" "$owner_pid" "$owner_start" "" "$desktop" "$uid" || return
    attached_cli_read_process \
        "$proc_root" "$authority_pid" "$authority_start" "$owner_pid" "$canonical_codex" "$uid" || return
    attached_cli_read_authority_command "$proc_root" "$authority_pid" "$codex" "$socket" "$uid" || return
    attached_cli_read_listener "$proc_root" "$authority_pid" "$socket" "$uid" || return
    attached_cli_read_metadata "$codex" || return
    [[ $ATTACHED_CLI_META_RAW == "$codex_metadata" &&
        $(attached_cli_canonical_executable "$codex") == "$canonical_codex" ]] || return "$ATTACHED_CLI_UNSAFE"
    attached_cli_read_metadata "$canonical_codex" || return
    [[ $ATTACHED_CLI_META_RAW == "$canonical_metadata" ]] || return "$ATTACHED_CLI_UNSAFE"
    ATTACHED_CLI_SNAPSHOT=$ATTACHED_CLI_SNAPSHOT_BUILD
    ATTACHED_CLI_VERIFIED_CODEX=$canonical_codex
    ATTACHED_CLI_VERIFIED_SOCKET=$socket
    unset ATTACHED_CLI_SNAPSHOT_BUILD
}

attached_cli_print_snapshot_error() {
    case $1 in
        "$ATTACHED_CLI_UNAVAILABLE")
            printf '%s\n' 'codex-desktop: Desktop shared app server is not available' >&2
            ;;
        "$ATTACHED_CLI_UNSAFE")
            printf '%s\n' 'codex-desktop: Desktop shared app-server state is unsafe' >&2
            ;;
        "$ATTACHED_CLI_MISMATCH")
            printf '%s\n' 'codex-desktop: shared app-server authority does not match Desktop' >&2
            ;;
        *)
            printf '%s\n' 'codex-desktop: Desktop shared app-server state is unsafe' >&2
            ;;
    esac
}

attached_cli_main() {
    local record_dir=$1 proc_root=$2 initial_snapshot snapshot_status argument

    shift 2
    for argument in "$@"; do
        [[ $argument != -- ]] || break
        case $argument in
            --remote|--remote=*|--remote-auth-token-env|--remote-auth-token-env=*|--sock|--sock=*|--listen|--listen=*|unix://*|ws://*|wss://*|app-server|remote-control|mcp-server|exec-server)
                printf '%s\n' \
                    'codex-desktop: --cli does not accept caller endpoint or authority options' >&2
                return 2
                ;;
        esac
    done

    if (($# == 1)) && [[ $1 == -h || $1 == --help || $1 == -V || $1 == --version ]]; then
        exec "${CODEX_LINUX_APP_DIR:?}/resources/codex" "$@"
    fi
    if (($# > 0)) && [[ $1 == help ]]; then
        exec "${CODEX_LINUX_APP_DIR:?}/resources/codex" "$@"
    fi

    attached_cli_snapshot "$record_dir" "$proc_root"
    snapshot_status=$?
    if ((snapshot_status != 0)); then
        attached_cli_print_snapshot_error "$snapshot_status"
        return 1
    fi
    initial_snapshot=$ATTACHED_CLI_SNAPSHOT
    if ! attached_cli_snapshot "$record_dir" "$proc_root"; then
        attached_cli_print_snapshot_error "$ATTACHED_CLI_UNSAFE"
        return 1
    fi
    if [[ $ATTACHED_CLI_SNAPSHOT != "$initial_snapshot" ]]; then
        attached_cli_print_snapshot_error "$ATTACHED_CLI_UNSAFE"
        return 1
    fi
    exec "$ATTACHED_CLI_VERIFIED_CODEX" \
        --remote "unix://$ATTACHED_CLI_VERIFIED_SOCKET" "$@"
}

attached_cli_record_dir() {
    local runtime_root=${XDG_RUNTIME_DIR:-${CODEX_LINUX_APP_STATE_DIR:-}}
    local app_id=${CODEX_LINUX_APP_ID:-codex-desktop}

    [[ $runtime_root == /* && -n $app_id && $app_id != */* &&
        $runtime_root != *$'\n'* && $app_id != *$'\n'* ]] || return 1
    printf '%s/%s/app-server-bridge\n' "${runtime_root%/}" "$app_id"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    attached_cli_id_bin=$(command -v id 2>/dev/null) || attached_cli_id_bin=
    attached_cli_stat_bin=$(command -v stat 2>/dev/null) || attached_cli_stat_bin=
    attached_cli_readlink_bin=$(command -v readlink 2>/dev/null) || attached_cli_readlink_bin=
    if [[ $attached_cli_id_bin != /* || ! -f $attached_cli_id_bin || ! -x $attached_cli_id_bin ||
        $attached_cli_stat_bin != /* || ! -f $attached_cli_stat_bin || ! -x $attached_cli_stat_bin ||
        $attached_cli_readlink_bin != /* || ! -f $attached_cli_readlink_bin ||
        ! -x $attached_cli_readlink_bin ]]; then
        attached_cli_print_snapshot_error "$ATTACHED_CLI_UNSAFE"
        exit 1
    fi
    readonly ATTACHED_CLI_ID_BIN=$attached_cli_id_bin
    readonly ATTACHED_CLI_STAT_BIN=$attached_cli_stat_bin
    readonly ATTACHED_CLI_READLINK_BIN=$attached_cli_readlink_bin

    attached_cli_effective_uid() {
        "$ATTACHED_CLI_ID_BIN" -u 2>/dev/null
    }
    attached_cli_canonical_executable() {
        "$ATTACHED_CLI_READLINK_BIN" -e -- "$1" 2>/dev/null
    }
    attached_cli_filesystem_metadata() {
        local target=$1 metadata kind link=

        metadata=$(LC_ALL=C "$ATTACHED_CLI_STAT_BIN" -c $'%F\t%a\t%u\t%d\t%i' -- "$target" \
            2>/dev/null) || return 1
        kind=${metadata%%$'\t'*}
        if [[ $kind == "symbolic link" ]]; then
            link=$("$ATTACHED_CLI_READLINK_BIN" -- "$target" 2>/dev/null) || return 1
        fi
        printf '%s\t%s\n' "$metadata" "$link"
    }
    readonly -f attached_cli_effective_uid attached_cli_canonical_executable attached_cli_filesystem_metadata

    attached_cli_direct_record_dir=$(attached_cli_record_dir) || {
        attached_cli_print_snapshot_error "$ATTACHED_CLI_UNSAFE"
        exit 1
    }
    readonly ATTACHED_CLI_DIRECT_RECORD_DIR=$attached_cli_direct_record_dir
    readonly ATTACHED_CLI_DIRECT_PROC_ROOT=/proc
    attached_cli_record_dir() {
        printf '%s\n' "$ATTACHED_CLI_DIRECT_RECORD_DIR"
    }
    readonly -f attached_cli_record_dir
    attached_cli_main "$(attached_cli_record_dir)" "$ATTACHED_CLI_DIRECT_PROC_ROOT" "$@"
    exit $?
fi
