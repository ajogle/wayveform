"""Create an unsigned portable Electron archive for the selected target platform."""

def _portable_bundle_impl(ctx):
    staged = ctx.attr.cross_inputs[DefaultInfo].files.to_list()
    if len(staged) != 1:
        fail("cross_inputs must provide one directory")

    output = ctx.actions.declare_file(ctx.label.name + ".zip")
    modules = ctx.attr.runtime_node_modules[DefaultInfo].files.to_list()
    args = ctx.actions.args()
    args.add(output.path)
    args.add(staged[0].path)
    if ctx.target_platform_has_constraint(ctx.attr._linux_os[platform_common.ConstraintValueInfo]):
        args.add("linux")
    elif ctx.target_platform_has_constraint(ctx.attr._macos_os[platform_common.ConstraintValueInfo]):
        args.add("macos")
    elif ctx.target_platform_has_constraint(ctx.attr._windows_os[platform_common.ConstraintValueInfo]):
        args.add("windows")
    else:
        fail("unsupported operating system")
    if ctx.target_platform_has_constraint(ctx.attr._x64_cpu[platform_common.ConstraintValueInfo]):
        args.add("x64")
    elif ctx.target_platform_has_constraint(ctx.attr._arm64_cpu[platform_common.ConstraintValueInfo]):
        args.add("arm64")
    else:
        fail("unsupported CPU")
    args.add_all([f.path for f in modules])

    ctx.actions.run(
        executable = ctx.executable.tool,
        inputs = depset(staged + modules),
        outputs = [output],
        arguments = [args],
        mnemonic = "PortableElectronBundle",
        progress_message = "Bundling Wayveform for %{label}",
    )
    return [DefaultInfo(files = depset([output]))]

portable_bundle = rule(
    implementation = _portable_bundle_impl,
    attrs = {
        "cross_inputs": attr.label(mandatory = True),
        "runtime_node_modules": attr.label(mandatory = True, cfg = "exec"),
        "tool": attr.label(mandatory = True, executable = True, cfg = "exec"),
        "_linux_os": attr.label(default = "@platforms//os:linux"),
        "_macos_os": attr.label(default = "@platforms//os:macos"),
        "_windows_os": attr.label(default = "@platforms//os:windows"),
        "_x64_cpu": attr.label(default = "@platforms//cpu:x86_64"),
        "_arm64_cpu": attr.label(default = "@platforms//cpu:aarch64"),
    },
)
