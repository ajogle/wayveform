"""Stage host-built application code with target-platform runtime inputs."""

def _cross_inputs_impl(ctx):
    output = ctx.actions.declare_directory(ctx.label.name)
    app_files = ctx.attr.app_js[DefaultInfo].files.to_list()
    runtime = ctx.attr.runtime_zip[DefaultInfo].files.to_list()
    addon = ctx.attr.sqlite_addon[DefaultInfo].files.to_list()
    if len(runtime) != 1 or len(addon) != 1:
        fail("runtime_zip and sqlite_addon must each provide exactly one file")

    ctx.actions.run_shell(
        inputs = depset(app_files + runtime + addon + [ctx.file.package_json, ctx.file.license]),
        outputs = [output],
        arguments = [output.path, runtime[0].path, addon[0].path, ctx.file.package_json.path, ctx.file.license.path] + [f.path for f in app_files],
        command = """
set -eu
output="$1"
runtime="$2"
addon="$3"
package_json="$4"
license="$5"
shift 5
mkdir -p "$output/app/dist" "$output/native" "$output/runtime"
cp "$package_json" "$output/app/package.json"
cp "$license" "$output/app/LICENSE"
cp "$runtime" "$output/runtime/electron.zip"
cp "$addon" "$output/native/better_sqlite3.node"
for src in "$@"; do
  cp -R "$src" "$output/app/dist/"
done
""",
        mnemonic = "StageCrossPlatformInputs",
    )
    return [DefaultInfo(files = depset([output]))]

cross_inputs = rule(
    implementation = _cross_inputs_impl,
    attrs = {
        "app_js": attr.label(mandatory = True, cfg = "exec"),
        "runtime_zip": attr.label(mandatory = True),
        "sqlite_addon": attr.label(mandatory = True),
        "package_json": attr.label(mandatory = True, allow_single_file = True),
        "license": attr.label(mandatory = True, allow_single_file = True),
    },
)
