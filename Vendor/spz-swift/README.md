# spz-swift

A pure Swift port of [nianticlabs/spz](https://github.com/nianticlabs/spz) - the SPZ file format library for 3D Gaussian splats.

## Overview

SPZ is a compressed file format for 3D Gaussian splats, achieving approximately 10x smaller file sizes compared to PLY format with minimal visual quality loss. This library provides reading and writing support for SPZ files in Swift.

## Features

- **Load SPZ files** - Decompress and parse SPZ data into `GaussianCloud` structures
- **Save SPZ files** - Compress and serialize `GaussianCloud` data to SPZ format
- **Coordinate system conversion** - Convert between different 3D coordinate systems (RDF, RUB, etc.)
- **Full spherical harmonics support** - Degrees 0-3 (up to 45 SH coefficients per point)
- **Pure Swift** - No C/C++ dependencies, uses Foundation's Compression framework

## Installation

Add to your `Package.swift`:

```swift
dependencies: [
    .package(path: "../spz-swift")
]
```

Or:

```swift
dependencies: [
    .package(url: "https://github.com/your-repo/spz-swift.git", from: "1.0.0")
]
```

## Usage

### Loading an SPZ file

```swift
import spz

// Load from file
let cloud = try loadSpz(from: url)
print("Loaded \(cloud.numPoints) gaussians")

// Load from Data
let data = try Data(contentsOf: url)
let cloud = try loadSpz(data)

// Specify target coordinate system
let cloud = try loadSpz(from: url, options: UnpackOptions(to: .rdf))
```

### Saving to SPZ format

```swift
import spz

var cloud = GaussianCloud()
cloud.numPoints = 100
cloud.shDegree = 0
cloud.positions = [/* ... */]
cloud.scales = [/* ... */]
cloud.rotations = [/* ... */]
cloud.alphas = [/* ... */]
cloud.colors = [/* ... */]

// Save to file
try saveSpz(cloud, to: url)

// Get compressed data
let spzData = try saveSpz(cloud)
```

### GaussianCloud Structure

```swift
public struct GaussianCloud {
    var numPoints: Int32       // Number of gaussians
    var shDegree: Int32        // Spherical harmonics degree (0-3)
    var antialiased: Bool      // Mip-splatting mode
    var positions: [Float]     // xyz positions (numPoints * 3)
    var scales: [Float]        // log-scale values (numPoints * 3)
    var rotations: [Float]     // xyzw quaternions (numPoints * 4)
    var alphas: [Float]        // pre-sigmoid opacity (numPoints)
    var colors: [Float]        // SH DC component (numPoints * 3)
    var sh: [Float]            // Higher SH coefficients
}
```

## License

MIT License - see [LICENSE](LICENSE)

This is a Swift port of the original C++ implementation by Niantic Labs.

## Credits

- Original C++ implementation: [nianticlabs/spz](https://github.com/nianticlabs/spz)
- SPZ format specification: [scaniverse.com/spz](https://scaniverse.com/spz)
