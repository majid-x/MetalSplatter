export const productSearchConfig = {
  cloudinaryCloudName: 'dna3zaknx',
  cloudinaryUploadPreset: 'vroomkplaycanvas',
  searchApiKey: '4ujfCpHGxFRN3Lnp49mGr8zg',
  get isConfigured() {
    return (
      this.cloudinaryCloudName.length > 0 &&
      this.cloudinaryUploadPreset.length > 0 &&
      this.searchApiKey.length > 0
    )
  }
} as const
