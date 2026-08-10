export function galleryVisibilityClassName(collectionView) {
  if (collectionView?.type !== 'gallery') return ''

  const format = collectionView?.format || {}
  const classNames = []
  const hasLegacyTitleSetting =
    typeof format.gallery_title_visible === 'boolean'

  if (
    format.show_page_icon === false ||
    (format.show_page_icon == null && !hasLegacyTitleSetting)
  ) {
    classNames.push('notion-gallery-hide-page-icons')
  }

  const titleProperty = format.gallery_properties?.find(
    property => property?.property === 'title'
  )
  if (
    titleProperty?.visible === false ||
    (titleProperty == null && format.gallery_title_visible === false)
  ) {
    classNames.push('notion-gallery-hide-titles')
  }

  return classNames.join(' ')
}
