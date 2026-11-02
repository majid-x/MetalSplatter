import extract from 'extract-zip'
import { mkdir, readFile, readdir, rm, stat } from 'fs/promises'
import { basename, dirname, extname, join } from 'path'
import {
  cameraFromStartPose,
  navSummary,
  parseNav,
  type NavSummary,
  type SceneNavigation,
  type SceneStartPose
} from './navParser'
import { extractDirectory } from './projectStore'

const MODEL_EXTENSIONS = new Set(['.ply', '.splat', '.spz'])
const NAV_NAMES = new Set(['nav.txt', 'navigation.txt', 'scene-nav.txt'])
const COLLISION_NAMES = new Set([
  'collision.glb',
  'collider.glb',
  'walkable.glb',
  'collision.gltf',
  'collider.gltf'
])

export type ScenePackageContents = {
  modelPath: string
  extractDir: string | null
  navigationPath: string | null
  collisionPath: string | null
  startPose: SceneStartPose | null
  navigation: SceneNavigation | null
  navSummary: NavSummary | null
  camera: {
    position: [number, number, number]
    target: [number, number, number]
    fov: number
  } | null
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__MACOSX') continue
      out.push(...(await walkFiles(full)))
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
  return out
}

async function preferLargestModel(files: string[]): Promise<string | null> {
  const models = files.filter((file) => MODEL_EXTENSIONS.has(extname(file).toLowerCase()))
  if (models.length === 0) return null
  if (models.length === 1) return models[0]

  let best = models[0]
  let bestSize = -1
  for (const model of models) {
    try {
      const size = (await stat(model)).size
      if (size > bestSize) {
        best = model
        bestSize = size
      }
    } catch {
      // ignore
    }
  }
  return best
}

function firstNavigation(files: string[]): string | null {
  const preferred = files.find((file) => NAV_NAMES.has(basename(file).toLowerCase()))
  if (preferred) return preferred
  return files.find((file) => extname(file).toLowerCase() === '.txt') ?? null
}

function firstCollision(files: string[]): string | null {
  const preferred = files.find((file) => COLLISION_NAMES.has(basename(file).toLowerCase()))
  if (preferred) return preferred
  return (
    files.find((file) => {
      const ext = extname(file).toLowerCase()
      return ext === '.glb' || ext === '.gltf'
    }) ?? null
  )
}

async function readNavigation(
  navigationPath: string | null
): Promise<SceneNavigation | null> {
  if (!navigationPath) return null
  try {
    const text = await readFile(navigationPath, 'utf8')
    return parseNav(text)
  } catch {
    return null
  }
}

async function packageFromFiles(
  files: string[],
  extractDir: string | null
): Promise<ScenePackageContents> {
  const modelPath = await preferLargestModel(files)
  if (!modelPath) {
    throw new Error("This project package doesn't include a 3D scene file.")
  }
  const navigationPath = firstNavigation(files)
  const collisionPath = firstCollision(files)
  const navigation = await readNavigation(navigationPath)
  const startPose: SceneStartPose | null = navigation
    ? {
        position: navigation.startPosition,
        yawDegrees: navigation.yawDegrees,
        pitchDegrees: navigation.pitchDegrees,
        moveSpeed: navigation.moveSpeed,
        measureScale: navigation.measureScale
      }
    : null
  return {
    modelPath,
    extractDir,
    navigationPath,
    collisionPath,
    startPose,
    navigation,
    navSummary: navSummary(navigation),
    // Pass full navigation so [orientation] yaw/pitch match Mac eye-level start.
    camera: navigation ? cameraFromStartPose(navigation) : null
  }
}

export async function loadScenePackage(
  packagePath: string,
  projectId: string
): Promise<ScenePackageContents> {
  const ext = extname(packagePath).toLowerCase()

  if (MODEL_EXTENSIONS.has(ext)) {
    // Prefer sibling files in the same folder (extracted scene/ with nav.txt).
    const dir = dirname(packagePath)
    const siblings = await walkFiles(dir)
    if (siblings.length > 1) {
      return packageFromFiles(siblings, dir)
    }
    return {
      modelPath: packagePath,
      extractDir: null,
      navigationPath: null,
      collisionPath: null,
      startPose: null,
      navigation: null,
      navSummary: null,
      camera: null
    }
  }

  if (ext !== '.zip') {
    throw new Error(
      "This file type isn't supported. Use a project package or a .ply / .splat / .spz file."
    )
  }

  const dest = extractDirectory(projectId)
  const existingFiles = await walkFiles(dest)
  if (await preferLargestModel(existingFiles)) {
    return packageFromFiles(existingFiles, dest)
  }

  await rm(dest, { recursive: true, force: true })
  await mkdir(dest, { recursive: true })

  try {
    await extract(packagePath, { dir: dest })
  } catch (error) {
    if (error instanceof Error && /ENOSPC|no space/i.test(error.message)) {
      throw new Error('Not enough storage to open this project.')
    }
    throw new Error("Couldn't open the project package. Try downloading again.")
  }

  return packageFromFiles(await walkFiles(dest), dest)
}
