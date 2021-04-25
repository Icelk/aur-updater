import fs = require("fs")
import fetch = require("node-fetch")
import { execFile } from "child-process-promise"

let forceUpdate = false

const packageGitPath = "remote"
const pkgBuildVerRegex = /pkgver=.*/

const request: (
    method: "GET" | "POST" | "PUT",
    url: string,
    download?: boolean
) => Promise<fetch.Response> = async (method, url, download = false) => {
    const uri = url.startsWith("http") ? url : `https://api.github.com${url}`
    return await fetch.default(uri, {
        method,
        headers: {
            accept: download
                ? "application/octet-stream"
                : "application/vnd.github.v3+json",
            agent: "AUR updates",
        },
    })
}

enum Arch {
    x86_64,
    i686,
    aarch64,
    armv7h,
}
function firstArchSubstring(text: string): Arch | null {
    const associations = [
        [Arch.x86_64, "x64"],
        [Arch.x86_64, "x86_64"],
        [Arch.x86_64, "x86-64"],
        [Arch.i686, "i386"],
        [Arch.i686, "i486"],
        [Arch.i686, "i586"],
        [Arch.i686, "i686"],
        [Arch.i686, "x86-32"],
        [Arch.i686, "x86_32"],
        [Arch.i686, "ia32"],

        [Arch.aarch64, "aarch64"],
        [Arch.aarch64, "arm64"],
        [Arch.armv7h, "armv7h"],
        [Arch.armv7h, "armhf"],
        [Arch.i686, "x86"],
    ]
    for (let i = 0; i < associations.length; i++) {
        const association = associations[i]
        if (text.indexOf(association[1] as string) >= 0) {
            return association[0] as Arch
        }
    }
    return null
}
function findPkgVer(file: string): string | null {
    const matches = file.match(pkgBuildVerRegex)
    if (matches === null) {
        return null
    } else {
        return matches[0].split("pkgver=")[1]
    }
}

type GenericObject = { [key: string]: any }

async function run() {
    const config: GenericObject = JSON.parse(
        (await fs.promises.readFile("config.json")).toString()
    )

    const globalConfig: GenericObject =
        typeof config.global === "object" ? config.global : {}
    if (typeof config.packages !== "object") {
        console.error("Config has to have an array of packages!")
        process.exit(1)
    }

    let exitStatus = 0

    config.packages.forEach(async (pkg: GenericObject) => {
        const pkgConfig = Object.assign({}, globalConfig, pkg)
        console.log(
            "Processing package " +
                pkgConfig.name +
                " with config " +
                JSON.stringify(pkgConfig, null, 2)
        )

        const newExitStatus = await processPackage(pkgConfig)
        if (exitStatus === 0) {
            exitStatus = newExitStatus
        }

        if (newExitStatus !== 0) {
            console.error("Failed to process package. See output above.")
        }
    })

    if (exitStatus !== 0) {
        process.exit(exitStatus)
    }
}
async function processPackage(config: any): Promise<number> {
    if (
        config.name === undefined ||
        config.repo === undefined ||
        config.owner === undefined
    ) {
        console.error(
            "Missing fields in configuration. Requires `name`, `repo`, and `owner`."
        )
        return 1
    }

    const gitPath = `${packageGitPath}-${config.name}`

    const pkgBuildPath = config.pkgbuild ?? "PKGBUILD"

    let pkgBuild = (
        await fs.promises.readFile(`${gitPath}/${pkgBuildPath}`)
    ).toString()

    const latestSynced = findPkgVer(pkgBuild)

    const githubData = await (
        await request(
            "GET",
            `/repos/${config.owner}/${config.repo}/releases/latest`
        )
    ).json()
    const remoteTag = githubData.tag_name
    const update = remoteTag !== latestSynced || forceUpdate

    if (update) {
        if (!(config.dry_run ?? false)) {
            await execFile("git", ["pull"], { cwd: gitPath, encoding: "utf8" })
        }

        pkgBuild = (
            await fs.promises.readFile(`${gitPath}/${pkgBuildPath}`)
        ).toString()

        const verAfterPull = findPkgVer(pkgBuild)
        if (verAfterPull === remoteTag && !forceUpdate) {
            return 0
        }

        console.log(
            "Updating package. Current: " +
                verAfterPull +
                " Newest: " +
                remoteTag
        )

        return await updatePackage(
            config.name,
            gitPath,
            githubData,
            config.sum_filter_regex ?? "",
            remoteTag,
            pkgBuildPath,
            config.srcinfo ?? ".SRCINFO",
            config.dry_run ?? false
        )
    }

    return 0
}
async function updatePackage(
    pkgName: string,
    remotePath: string,
    response: any,
    regex: string,
    newTag: string,
    pkgBuildPath: string,
    srcInfoPath: string,
    dryRun: boolean
): Promise<number> {
    const pkgBuild = (
        await fs.promises.readFile(`${remotePath}/${pkgBuildPath}`)
    ).toString("utf8")
    // Update PKGBUILD pkgver
    let newPkgBuild = pkgBuild.replace(pkgBuildVerRegex, `pkgver=${newTag}`)

    const signatureRegex = new RegExp(regex)
    const pkgBuildSumRegex = /sha([0-9]+)sums/g
    const assets: { name: string; url: string }[] = response.assets

    const arches: { arch: Arch; sigStart: number; sigEnd: number }[] = []
    const sumMatches = newPkgBuild.matchAll(pkgBuildSumRegex)
    for (const match of sumMatches) {
        if (match.index === undefined || match.length === 0) {
            console.log(pkgName + ": no signature fields, skipping")
            break
        }
        const end = match.index + match[0].length

        if (newPkgBuild.substring(end, end + 1) !== "_") {
            console.warn(
                pkgName +
                    ": signature definition without explicit arches are not supported"
            )
            continue
        }

        const s = newPkgBuild.substring(end)
        const eq = s.search(/[=]/)
        const arch = firstArchSubstring(s.substring(0, eq))
        const sigStart = s.search(/["']/) + 1
        const sigEnd = s.substring(sigStart).search(/["']/) + sigStart

        if (arch === null) {
            console.warn(
                pkgName + ": Arch '" + s.substring(0, eq) + "' not recognised."
            )
            continue
        }

        console.log(
            `${pkgName}: Found arch sum '${arch}' with sum ${s.substring(
                sigStart,
                sigEnd
            )}`
        )

        arches.push({
            arch,
            sigStart: sigStart + end,
            sigEnd: sigEnd + end,
        })
    }

    let numSumMatches = 0
    if (arches.length > 0) {
        const replaceSum = (start: number, end: number, newSum: string) => {
            console.log(
                `${pkgName}: Replacing sum ${newPkgBuild.substring(start, end)}`
            )

            newPkgBuild = `${newPkgBuild.substring(
                0,
                start
            )}${newSum}${newPkgBuild.substring(end)}`

            const offset = start - end + newSum.length
            for (let i = 0; i < arches.length; i++) {
                const arch = arches[i]
                if (arch.sigStart > end) {
                    arch.sigStart += offset
                    arch.sigEnd += offset
                }
            }
        }
        const getReplaceSum = async (
            start: number,
            end: number,
            url: string
        ) => {
            const response = await request("GET", url, true)
            const sum = (await response.text()).split(" ")[0]
            console.log(pkgName + ": Got sum " + sum)

            replaceSum(start, end, sum)
        }

        for (let assetIndex = 0; assetIndex < assets.length; assetIndex++) {
            const asset = assets[assetIndex]

            const name = asset.name
            if (!signatureRegex.test(name)) {
                continue
            }
            console.log(pkgName + ": Applicable asset: " + name)

            const firstArch = firstArchSubstring(name)

            for (let archIndex = 0; archIndex < arches.length; archIndex++) {
                const arch = arches[archIndex]

                if (arch.arch === firstArch) {
                    const url = asset.url

                    getReplaceSum(arch.sigStart, arch.sigEnd, url)
                    numSumMatches += 1
                }
            }
        }
    }
    if (arches.length !== numSumMatches) {
        console.error(
            pkgName +
                ": Number of architecture sums and number of matches are not equal"
        )
        return 1
    }

    if (!dryRun) {
        fs.promises.writeFile(`${remotePath}/${pkgBuildPath}`, newPkgBuild)

        // Execute makepkg after writing to PKGBUILD
        const makePkgOutput = await execFile("makepkg", ["--printsrcinfo"], {
            cwd: remotePath,
            encoding: "utf8",
        })
        if (makePkgOutput.childProcess.exitCode !== 0) {
            console.error(pkgName + ": makepkg failed!")
            console.error(makePkgOutput.stderr)

            return 1
        } else {
            await fs.promises.writeFile(
                `${remotePath}/${srcInfoPath}`,
                makePkgOutput.stdout
            )
        }
        const diff = await execFile("git", ["diff"], {
            cwd: remotePath,
            encoding: "utf8",
        })
        const hasChanged = diff.stdout.length > 0

        if (hasChanged) {
            await execFile("git", ["add", "."], {
                cwd: remotePath,
                encoding: "utf8",
            })
            await execFile(
                "git",
                [
                    "commit",
                    "-m",
                    `Updated to ${newTag}\nThis was an auto-update by https://github.com/Icelk/aur-updater`,
                ],
                { cwd: remotePath, encoding: "utf8" }
            )

            const gitPushOutput = await execFile("git", ["push"], {
                cwd: remotePath,
                encoding: "utf8",
            }).then(
                (o) => {
                    return o
                },
                (err) => {
                    console.error(
                        pkgName +
                            ": You don't have the permissions to push changes"
                    )
                    console.error(err)
                    return null
                }
            )
            if (gitPushOutput === null) {
                return 1
            }
            if (gitPushOutput.childProcess.exitCode !== 0) {
                console.error(pkgName + ": Failed to `git push`!")
                console.error(gitPushOutput.stderr)
            } else {
                console.log(pkgName + ": Pushed changes")
            }
        } else {
            console.error(
                pkgName +
                    ": Nothing changed according to Git, yet we have updated!"
            )
        }
    }
    return 0
}

forceUpdate = process.argv.indexOf("--force-update") > 1

let f = async () => {
    run()
}
f()
