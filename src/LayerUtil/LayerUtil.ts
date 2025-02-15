import Logger from '@terrestris/base-util/dist/Logger';
import StringUtil from '@terrestris/base-util/dist/StringUtil/StringUtil';
import OpenLayersParser from 'geostyler-openlayers-parser';
import { isNil } from 'lodash';
import _uniq from 'lodash/uniq';
import { Extent as OlExtent } from 'ol/extent';
import OlFormatGeoJSON from 'ol/format/GeoJSON';
import OlLayerImage from 'ol/layer/Image';
import OlLayer from 'ol/layer/Layer';
import OlLayerTile from 'ol/layer/Tile';
import OlLayerVector from 'ol/layer/Vector';
import OlSourceImageWMS from 'ol/source/ImageWMS';
import OlSourceOSM from 'ol/source/OSM';
import OlSourceStamen from 'ol/source/Stamen';
import OlSourceTileWMS from 'ol/source/TileWMS';
import OlSourceVector from 'ol/source/Vector';
import OlSourceWMTS from 'ol/source/WMTS';

import CapabilitiesUtil from '../CapabilitiesUtil/CapabilitiesUtil';
import { InkmapGeoJsonLayer, InkmapLayer } from './InkmapTypes';

/**
 * Helper class for layer interaction.
 *
 * @class LayerUtil
 */
class LayerUtil {

  /**
   * Returns the configured URL of the given layer.
   *
   * @param { OlLayerTile<OlSourceTileWMS> | OlLayerImage<OlSourceImageWMS> | OlLayerTile<OlSourceWMTS>} layer The layer
   *   to get the URL from.
   * @returns {string} The layer URL.
   */
  static getLayerUrl = (
    layer: OlLayerTile<OlSourceTileWMS> | OlLayerImage<OlSourceImageWMS> | OlLayerTile<OlSourceWMTS>
  ): string => {
    const layerSource = layer.getSource();

    if (layerSource instanceof OlSourceTileWMS) {
      return layerSource.getUrls()?.[0] ?? '';
    } else if (layerSource instanceof OlSourceImageWMS) {
      return layerSource.getUrl() ?? '';
    } else if (layerSource instanceof OlSourceWMTS) {
      return layerSource.getUrls()?.[0] ?? '';
    }
    return '';
  };

  /**
   * Returns the extent of the given layer as defined in the
   * appropriate Capabilities document.
   *
   * @param { OlLayerTile<OlSourceTileWMS> | OlLayerImage<OlSourceImageWMS>} layer
   * @param {RequestInit} fetchOpts Optional fetch options to make use of
   *                                while requesting the Capabilities.
   * @returns {Promise<[number, number, number, number]>} The extent of the layer.
   */
  static async getExtentForLayer(
    layer:  OlLayerTile<OlSourceTileWMS> | OlLayerImage<OlSourceImageWMS>,
    fetchOpts: RequestInit = {}
  ): Promise<OlExtent> {
    const capabilities = await CapabilitiesUtil.getWmsCapabilitiesByLayer(layer, fetchOpts);

    if (!capabilities?.Capability?.Layer?.Layer) {
      throw new Error('Unexpected format of the Capabilities.');
    }

    const layerName = layer.getSource()?.getParams().LAYERS;
    const capabilitiesLayer = capabilities.Capability.Layer.Layer;
    const layers = capabilitiesLayer.filter((l: any) => {
      return l.Name === layerName;
    });

    if (!layers || layers.length === 0) {
      throw new Error('Could not find the desired layer in the Capabilities.');
    }

    const extent: OlExtent = layers[0].EX_GeographicBoundingBox;

    if (!extent || extent.length !== 4) {
      throw new Error('No extent set in the Capabilities.');
    }

    return extent;
  }

  /**
   * Converts a given OpenLayers layer to an inkmap layer spec.
   *
   */
  static async mapOlLayerToInkmap(
    olLayer: OlLayer
  ): Promise<InkmapLayer> {
    const source = olLayer.getSource();
    if (!olLayer.getVisible()) {
      // do not include invisible layers
      return Promise.reject();
    }
    const opacity = olLayer.getOpacity();
    const legendUrl = olLayer.get('legendUrl');
    const layerName = olLayer.get('name');

    // todo: introduce config object which hold possible additional configurations
    const attributionString = LayerUtil.getLayerAttributionsText(olLayer, ' ,', true);

    if (source instanceof OlSourceTileWMS) {
      return {
        type: 'WMS',
        url: source.getUrls()?.[0] ?? '',
        opacity,
        attribution: attributionString,
        layer: source.getParams()?.LAYERS,
        tiled: true,
        legendUrl,
        layerName
      };
    } else if (source instanceof OlSourceImageWMS) {
      return {
        type: 'WMS',
        url: source.getUrl() ?? '',
        opacity,
        attribution: attributionString,
        layer: source.getParams()?.LAYERS,
        tiled: false,
        legendUrl,
        layerName
      };
    } else if (source instanceof OlSourceWMTS) {
      const olTileGrid = source.getTileGrid();
      const resolutions = olTileGrid?.getResolutions();
      const matrixIds = resolutions?.map((res, idx) => idx);

      const tileGrid = {
        resolutions: olTileGrid?.getResolutions(),
        extent: olTileGrid?.getExtent(),
        matrixIds: matrixIds
      };

      return {
        type: 'WMTS',
        requestEncoding: source.getRequestEncoding(),
        url: source.getUrls()?.[0] ?? '',
        layer: source.getLayer(),
        projection: source.getProjection()?.getCode(),
        matrixSet: source.getMatrixSet(),
        tileGrid,
        format: source.getFormat(),
        opacity,
        attribution: attributionString,
        legendUrl,
        layerName
      };
    } else if (source instanceof OlSourceOSM) {
      return {
        type: 'XYZ',
        url: 'https://{a-c}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        opacity,
        attribution: '© OpenStreetMap (www.openstreetmap.org)',
        tiled: true,
        legendUrl,
        layerName
      };
    } else if (source instanceof OlSourceStamen) {
      const urls = source.getUrls();
      if (isNil(urls)) {
        return Promise.reject();
      }
      return {
        type: 'XYZ',
        url: urls[0],
        opacity,
        attribution: attributionString,
        tiled: true,
        legendUrl,
        layerName
      };
    } else if (source instanceof OlSourceVector) {
      const geojson = new OlFormatGeoJSON().writeFeaturesObject(source.getFeatures());
      const parser = new OpenLayersParser();
      const geojsonLayerConfig: InkmapGeoJsonLayer = {
        type: 'GeoJSON',
        geojson,
        attribution: attributionString,
        style: undefined,
        legendUrl,
        layerName
      };

      let olStyle = null;

      if (olLayer instanceof OlLayerVector<OlSourceVector>) {
        olStyle = olLayer.getStyle();
      }

      // todo: support style function / different styles per feature
      // const styles = source.getFeatures()?.map(f => f.getStyle());

      if (olStyle) {
        const gsStyle = await parser.readStyle(olStyle);
        if (gsStyle.errors) {
          Logger.error('Geostyler errors: ', gsStyle.errors);
        }
        if (gsStyle.warnings) {
          Logger.warn('Geostyler warnings: ', gsStyle.warnings);
        }
        if (gsStyle.unsupportedProperties) {
          Logger.warn('Detected unsupported style properties: ', gsStyle.unsupportedProperties);
        }
        if (gsStyle.output) {
          geojsonLayerConfig.style = gsStyle.output;
        }
      }
      return geojsonLayerConfig;
    }
    return Promise.reject();
  }

  /**
   * Returns all attributions as text joined by a separator.
   *
   * @param {OlLayer} layer The layer to get the attributions from.
   * @param {string} separator The separator separating multiple attributions.
   * @param {boolean} removeDuplicates Whether to remove duplicated attribution
   * strings or not.
   * @returns {string} The attributions.
   */
  static getLayerAttributionsText = (
    layer: OlLayer,
    separator: string = ', ',
    removeDuplicates: boolean = false
  ): string => {
    if (isNil(layer)) {
      return '';
    }
    const attributionsFn = layer.getSource()?.getAttributions();
    // @ts-ignore
    let attributions = attributionsFn ? attributionsFn(undefined) : null;

    let attributionString;
    if (Array.isArray(attributions)) {
      if (removeDuplicates) {
        attributions = _uniq(attributions);
      }
      attributionString = attributions.map(StringUtil.stripHTMLTags).join(separator);
    } else {
      attributionString = attributions ? StringUtil.stripHTMLTags(attributions) : '';
    }
    return attributionString;
  };

}

export default LayerUtil;
