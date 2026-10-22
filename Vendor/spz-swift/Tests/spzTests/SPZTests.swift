// spz-swift Tests
// MIT License - Copyright (c) 2024 Niantic Labs

import XCTest
@testable import spz

final class SPZTests: XCTestCase {

    func testGaussianCloudCreation() {
        var cloud = GaussianCloud()
        cloud.numPoints = 2
        cloud.shDegree = 0
        cloud.positions = [0, 0, 0, 1, 1, 1]
        cloud.scales = [0, 0, 0, 0, 0, 0]
        cloud.rotations = [0, 0, 0, 1, 0, 0, 0, 1]
        cloud.alphas = [0, 0]
        cloud.colors = [0, 0, 0, 1, 1, 1]
        cloud.sh = []

        XCTAssertTrue(cloud.checkSizes())
        XCTAssertEqual(cloud.numPoints, 2)
    }

    func testPackedGaussiansCreation() {
        var packed = PackedGaussians()
        packed.numPoints = 1
        packed.shDegree = 0
        packed.fractionalBits = 12
        packed.usesQuaternionSmallestThree = true

        packed.positions = Array(repeating: 0, count: 9)
        packed.scales = Array(repeating: 0, count: 3)
        packed.rotations = Array(repeating: 0, count: 4)
        packed.alphas = [128]
        packed.colors = Array(repeating: 128, count: 3)
        packed.sh = []

        XCTAssertTrue(packed.checkSizes())
    }

    func testCoordinateConverter() {
        let converter = coordinateConverter(from: .rdf, to: .rub)
        // RDF to RUB should flip Y and Z
        XCTAssertEqual(converter.flipP.x, 1.0)
        XCTAssertEqual(converter.flipP.y, -1.0)
        XCTAssertEqual(converter.flipP.z, -1.0)
    }

    func testHalfPrecisionConversion() {
        // Test some known values
        let one: Float = 1.0
        let half = floatToHalf(one)
        let back = halfToFloat(half)
        XCTAssertEqual(back, one, accuracy: 0.001)

        let zero: Float = 0.0
        let halfZero = floatToHalf(zero)
        let backZero = halfToFloat(halfZero)
        XCTAssertEqual(backZero, zero)
    }

    func testSHDegreeConversions() {
        XCTAssertEqual(dimForDegree(0), 0)
        XCTAssertEqual(dimForDegree(1), 3)
        XCTAssertEqual(dimForDegree(2), 8)
        XCTAssertEqual(dimForDegree(3), 15)

        XCTAssertEqual(degreeForDim(0), 0)
        XCTAssertEqual(degreeForDim(3), 1)
        XCTAssertEqual(degreeForDim(8), 2)
        XCTAssertEqual(degreeForDim(15), 3)
    }

    func testPackUnpackRoundTrip() throws {
        // Create a simple gaussian cloud
        var cloud = GaussianCloud()
        cloud.numPoints = 1
        cloud.shDegree = 0
        cloud.antialiased = false
        cloud.positions = [1.5, 2.5, 3.5]
        cloud.scales = [-2.0, -1.0, 0.0]
        cloud.rotations = [0, 0, 0, 1]  // Identity quaternion (x, y, z, w)
        cloud.alphas = [0]  // sigmoid(0) = 0.5
        cloud.colors = [0, 0, 0]
        cloud.sh = []

        XCTAssertTrue(cloud.checkSizes())

        // Pack it
        let packed = packGaussians(cloud, options: PackOptions())
        XCTAssertEqual(packed.numPoints, 1)

        // Unpack it
        let unpacked = unpackGaussians(packed, options: UnpackOptions())
        XCTAssertEqual(unpacked.numPoints, 1)

        // Positions should be close (within quantization error)
        XCTAssertEqual(unpacked.positions[0], cloud.positions[0], accuracy: 0.001)
        XCTAssertEqual(unpacked.positions[1], cloud.positions[1], accuracy: 0.001)
        XCTAssertEqual(unpacked.positions[2], cloud.positions[2], accuracy: 0.001)
    }

    func testSerializeDeserializeRoundTrip() throws {
        // Create a simple gaussian cloud
        var cloud = GaussianCloud()
        cloud.numPoints = 2
        cloud.shDegree = 0
        cloud.positions = [0, 0, 0, 1, 2, 3]
        cloud.scales = [0, 0, 0, -1, -1, -1]
        cloud.rotations = [0, 0, 0, 1, 0, 0, 0, 1]
        cloud.alphas = [0, 0]
        cloud.colors = [0, 0, 0, 0.5, 0.5, 0.5]
        cloud.sh = []

        // Save to SPZ format
        let spzData = try saveSpz(cloud, options: PackOptions())
        XCTAssertFalse(spzData.isEmpty)

        // Check gzip magic number
        XCTAssertEqual(spzData[0], 0x1f)
        XCTAssertEqual(spzData[1], 0x8b)

        // Load it back
        let loaded = try loadSpz(spzData, options: UnpackOptions())
        XCTAssertEqual(loaded.numPoints, cloud.numPoints)
        XCTAssertEqual(loaded.shDegree, cloud.shDegree)
    }

    func testLoadRealSPZFile() throws {
        // Try to load a real SPZ file from the samples
        let samplePath = "/Users/scier/Desktop/MetalSplatter/spz/samples/hornedlizard.spz"
        let url = URL(fileURLWithPath: samplePath)

        // Skip test if file doesn't exist
        guard FileManager.default.fileExists(atPath: samplePath) else {
            throw XCTSkip("Sample SPZ file not found at \(samplePath)")
        }

        let cloud = try loadSpz(from: url, options: UnpackOptions())

        // Verify the cloud has data
        XCTAssertGreaterThan(cloud.numPoints, 0)
        XCTAssertTrue(cloud.checkSizes())

        print("Loaded \(cloud.numPoints) gaussians with SH degree \(cloud.shDegree)")
    }
}
