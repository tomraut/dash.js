/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */
import DashConstants from './constants/DashConstants';
import FragmentRequest from '../streaming/vo/FragmentRequest';
import DashJSError from '../streaming/vo/DashJSError';
import {HTTPRequest} from '../streaming/vo/metrics/HTTPRequest';
import Events from '../core/events/Events';
import EventBus from '../core/EventBus';
import Errors from '../core/errors/Errors';
import FactoryMaker from '../core/FactoryMaker';
import Debug from '../core/Debug';
import URLUtils from '../streaming/utils/URLUtils';
import Representation from './vo/Representation';
import {
    replaceIDForTemplate,
    unescapeDollarsInTemplate,
    replaceTokenForTemplate,
    getTimeBasedSegment,
    getSegmentByIndex
} from './utils/SegmentsUtils';
import SegmentsGetter from './utils/SegmentsGetter';

import SegmentBaseLoader from './SegmentBaseLoader';
import WebmSegmentBaseLoader from './WebmSegmentBaseLoader';

function DashHandler(config) {

    config = config || {};
    const context = this.context;
    const eventBus = EventBus(context).getInstance();
    const urlUtils = URLUtils(context).getInstance();

    let segmentBaseLoader;
    const timelineConverter = config.timelineConverter;
    const dashMetrics = config.dashMetrics;
    const mediaPlayerModel = config.mediaPlayerModel;
    const errHandler = config.errHandler;
    const baseURLController = config.baseURLController;
    const settings = config.settings;

    let instance,
        logger,
        index,
        requestedTime,
        currentTime,
        streamProcessor,
        segmentsGetter;

    function setup() {
        logger = Debug(context).getInstance().getLogger(instance);
        resetInitialSettings();

        segmentBaseLoader = isWebM(config.mimeType) ? WebmSegmentBaseLoader(context).getInstance() : SegmentBaseLoader(context).getInstance();
        segmentBaseLoader.setConfig({
            baseURLController: baseURLController,
            dashMetrics: dashMetrics,
            mediaPlayerModel: mediaPlayerModel,
            errHandler: errHandler
        });

        eventBus.on(Events.INITIALIZATION_LOADED, onInitializationLoaded, instance);
        eventBus.on(Events.SEGMENTS_LOADED, onSegmentsLoaded, instance);
    }

    function isWebM (mimeType) {
        const type = mimeType ? mimeType.split('/')[1] : '';
        return 'webm' === type.toLowerCase();
    }

    function initialize(StreamProcessor) {
        streamProcessor = StreamProcessor;

        segmentBaseLoader.initialize();

        segmentsGetter = SegmentsGetter(context).create(config, isDynamic());
    }

    function getType() {
        return streamProcessor ? streamProcessor.getType() : null;
    }

    function isDynamic() {
        const streamInfo = streamProcessor ? streamProcessor.getStreamInfo() : null;
        return streamInfo ? streamInfo.manifestInfo.isDynamic : null;
    }

    function getMediaInfo() {
        return streamProcessor ? streamProcessor.getMediaInfo() : null;
    }

    function getStreamProcessor() {
        return streamProcessor;
    }

    function setCurrentTime(value) {
        currentTime = value;
    }

    function getCurrentTime() {
        return currentTime;
    }

    function resetIndex() {
        index = -1;
    }

    function resetInitialSettings() {
        resetIndex();
        currentTime = 0;
        requestedTime = null;
        streamProcessor = null;
        segmentsGetter = null;
    }

    function reset() {
        resetInitialSettings();

        eventBus.off(Events.INITIALIZATION_LOADED, onInitializationLoaded, instance);
        eventBus.off(Events.SEGMENTS_LOADED, onSegmentsLoaded, instance);
    }

    function setRequestUrl(request, destination, representation) {
        const baseURL = baseURLController.resolve(representation.path);
        let url,
            serviceLocation;

        if (!baseURL || (destination === baseURL.url) || (!urlUtils.isRelative(destination))) {
            url = destination;
        } else {
            url = baseURL.url;
            serviceLocation = baseURL.serviceLocation;

            if (destination) {
                url = urlUtils.resolve(destination, url);
            }
        }

        if (urlUtils.isRelative(url)) {
            return false;
        }

        request.url = url;
        request.serviceLocation = serviceLocation;

        return true;
    }

    function generateInitRequest(representation, mediaType) {
        const request = new FragmentRequest();
        const period = representation.adaptation.period;
        const presentationStartTime = period.start;
        const isDynamicStream = isDynamic();

        request.mediaType = mediaType;
        request.type = HTTPRequest.INIT_SEGMENT_TYPE;
        request.range = representation.range;
        request.availabilityStartTime = timelineConverter.calcAvailabilityStartTimeFromPresentationTime(presentationStartTime, period.mpd, isDynamicStream);
        request.availabilityEndTime = timelineConverter.calcAvailabilityEndTimeFromPresentationTime(presentationStartTime + period.duration, period.mpd, isDynamicStream);
        request.quality = representation.index;
        request.mediaInfo = getMediaInfo();
        request.representationId = representation.id;

        if (setRequestUrl(request, representation.initialization, representation)) {
            request.url = replaceTokenForTemplate(request.url, 'Bandwidth', representation.bandwidth);
            return request;
        }
    }

    function getInitRequest(representation) {
        if (!representation) return null;
        const request = generateInitRequest(representation, getType());
        return request;
    }

    function isMediaFinished(representation) {
        let isFinished = false;
        const isDynamicStream = isDynamic();

        if (!isDynamicStream && index === representation.availableSegmentsNumber) {
            isFinished = true;
        } else {
            const seg = getSegmentByIndex(index, representation);
            if (seg) {
                const time = parseFloat((seg.presentationStartTime - representation.adaptation.period.start).toFixed(5));
                const duration = representation.adaptation.period.duration;
                logger.debug(representation.segmentInfoType + ': ' + time + ' / ' + duration);
                isFinished = representation.segmentInfoType === DashConstants.SEGMENT_TIMELINE && isDynamicStream ? false : time >= duration;
            } else {
                logger.debug('isMediaFinished - no segment found');
            }
        }

        return isFinished;
    }

    function updateSegments(voRepresentation) {
        segmentsGetter.getSegments(voRepresentation, requestedTime, index, onSegmentListUpdated);
    }

    function onSegmentListUpdated(voRepresentation, segments) {
        voRepresentation.segments = segments;
        if (segments && segments.length > 0) {
            if (isDynamic()) {
                const lastSegment = segments[segments.length - 1];
                const liveEdge = lastSegment.presentationStartTime;
                // the last segment is the Expected, not calculated, live edge.
                timelineConverter.setExpectedLiveEdge(liveEdge);
                dashMetrics.updateManifestUpdateInfo({presentationStartTime: liveEdge});
            }
        }
    }

    function updateSegmentList(voRepresentation) {
        if (!voRepresentation) {
            throw new Error('no representation');
        }

        voRepresentation.segments = null;

        updateSegments(voRepresentation);
    }

    function updateRepresentation(voRepresentation, keepIdx) {
        const hasInitialization = Representation.hasInitialization(voRepresentation);
        const hasSegments = Representation.hasSegments(voRepresentation);
        let error;

        if (!voRepresentation.segmentDuration && !voRepresentation.segments) {
            updateSegmentList(voRepresentation);
        }

        voRepresentation.segmentAvailabilityRange = timelineConverter.calcSegmentAvailabilityRange(voRepresentation, isDynamic());

        if ((voRepresentation.segmentAvailabilityRange.end < voRepresentation.segmentAvailabilityRange.start) && !voRepresentation.useCalculatedLiveEdgeTime) {
            error = new DashJSError(Errors.SEGMENTS_UNAVAILABLE_ERROR_CODE, Errors.SEGMENTS_UNAVAILABLE_ERROR_MESSAGE, {availabilityDelay: voRepresentation.segmentAvailabilityRange.start - voRepresentation.segmentAvailabilityRange.end});
            eventBus.trigger(Events.REPRESENTATION_UPDATED, {sender: this, representation: voRepresentation, error: error});
            return;
        }

        if (!keepIdx) {
            resetIndex();
        }

        if (voRepresentation.segmentDuration) {
            updateSegmentList(voRepresentation);
        }

        if (!hasInitialization) {
            segmentBaseLoader.loadInitialization(voRepresentation);
        }

        if (!hasSegments) {
            segmentBaseLoader.loadSegments(voRepresentation, getType(), voRepresentation.indexRange);
        }

        if (hasInitialization && hasSegments) {
            eventBus.trigger(Events.REPRESENTATION_UPDATED, {sender: this, representation: voRepresentation});
        }
    }

    function getIndexForSegments(time, representation, timeThreshold) {
        const segments = representation.segments;
        const ln = segments ? segments.length : null;

        let idx = -1;
        let epsilon,
            frag,
            ft,
            fd,
            i;

        if (segments && ln > 0) {
            // In case timeThreshold is not provided, let's use the default value set in MediaPlayerModel
            timeThreshold = (timeThreshold === undefined || timeThreshold === null) ?
                settings.get().streaming.segmentOverlapToleranceTime : timeThreshold;

            for (i = 0; i < ln; i++) {
                frag = segments[i];
                ft = frag.presentationStartTime;
                fd = frag.duration;
                // In case timeThreshold is null, set epsilon to half the fragment duration
                epsilon = (timeThreshold === undefined || timeThreshold === null) ? fd / 2 : timeThreshold;
                if ((time + epsilon) >= ft &&
                    (time - epsilon) < (ft + fd)) {
                    idx = frag.availabilityIdx;
                    break;
                }
            }
        }

        return idx;
    }

    function getRequestForSegment(segment) {
        if (segment === null || segment === undefined) {
            return null;
        }

        const request = new FragmentRequest();
        const representation = segment.representation;
        const bandwidth = representation.adaptation.period.mpd.manifest.Period_asArray[representation.adaptation.period.index].
            AdaptationSet_asArray[representation.adaptation.index].Representation_asArray[representation.index].bandwidth;
        let url = segment.media;

        url = replaceTokenForTemplate(url, 'Number', segment.replacementNumber);
        url = replaceTokenForTemplate(url, 'Time', segment.replacementTime);
        url = replaceTokenForTemplate(url, 'Bandwidth', bandwidth);
        url = replaceIDForTemplate(url, representation.id);
        url = unescapeDollarsInTemplate(url);

        request.mediaType = getType();
        request.type = HTTPRequest.MEDIA_SEGMENT_TYPE;
        request.range = segment.mediaRange;
        request.startTime = segment.presentationStartTime;
        request.duration = segment.duration;
        request.timescale = representation.timescale;
        request.availabilityStartTime = segment.availabilityStartTime;
        request.availabilityEndTime = segment.availabilityEndTime;
        request.wallStartTime = segment.wallStartTime;
        request.quality = representation.index;
        request.index = segment.availabilityIdx;
        request.mediaInfo = getMediaInfo();
        request.adaptationIndex = representation.adaptation.index;
        request.representationId = representation.id;

        if (setRequestUrl(request, url, representation)) {
            return request;
        }
    }

    function getSegmentRequestForTime(representation, time, options) {
        let request,
            segment,
            finished;

        if (!representation) {
            return null;
        }

        const type = getType();
        const idx = index;
        const keepIdx = options ? options.keepIdx : false;
        const timeThreshold = options ? options.timeThreshold : null;
        const ignoreIsFinished = (options && options.ignoreIsFinished) ? true : false;

        if (requestedTime !== time) { // When playing at live edge with 0 delay we may loop back with same time and index until it is available. Reduces verboseness of logs.
            requestedTime = time;
            logger.debug('Getting the request for ' + type + ' time : ' + time);
        }

        updateSegments(representation);
        index = getIndexForSegments(time, representation, timeThreshold);

        //Index may be -1 if getSegments needs to update again.  So after getSegments is called and updated then try to get index again.
        if (index < 0) {
            updateSegments(representation);
            index = getIndexForSegments(time, representation, timeThreshold);
        }

        if (index >= 0) {
            logger.debug('Index for ' + type + ' time ' + time + ' is ' + index );
        }

        finished = !ignoreIsFinished ? isMediaFinished(representation) : false;
        if (finished) {
            request = new FragmentRequest();
            request.action = FragmentRequest.ACTION_COMPLETE;
            request.index = index;
            request.mediaType = type;
            request.mediaInfo = getMediaInfo();
            logger.debug('Signal complete in getSegmentRequestForTime -', type);
        } else {
            segment = getSegmentByIndex(index, representation);
            request = getRequestForSegment(segment);
        }

        if (keepIdx && idx >= 0) {
            index = representation.segmentInfoType === DashConstants.SEGMENT_TIMELINE && isDynamic() ? index : idx;
        }

        return request;
    }

    function getNextSegmentRequest(representation) {
        let request,
            segment,
            finished;

        if (!representation || index === -1) {
            return null;
        }

        const type = getType();
        const isDynamicStream = isDynamic();

        requestedTime = null;
        index++;

        logger.debug('Getting the next request at index: ' + index + ', type: ' + type);

        // check that there is a segment in this index. If none, update segments and wait for next time loop is called
        const seg = getSegmentByIndex(index, representation);
        if (!seg && isDynamicStream) {
            logger.debug('No segment found at index: ' + index + '. Wait for next loop');
            updateSegments(representation);
            index--;
            return null;
        }

        finished = isMediaFinished(representation);
        if (finished) {
            request = new FragmentRequest();
            request.action = FragmentRequest.ACTION_COMPLETE;
            request.index = index;
            request.mediaType = type;
            request.mediaInfo = getMediaInfo();
            logger.debug('Signal complete -', type);
        } else {
            updateSegments(representation);
            segment = getSegmentByIndex(index, representation);
            request = getRequestForSegment(segment);
            if (!segment && isDynamicStream) {
                /*
                 Sometimes when playing dynamic streams with 0 fragment delay at live edge we ask for
                 an index before it is available so we decrement index back and send null request
                 which triggers the validate loop to rerun and the next time the segment should be
                 available.
                 */
                index-- ;
            }
        }

        return request;
    }

    function onInitializationLoaded(e) {
        const representation = e.representation;
        if (!representation.segments) return;

        eventBus.trigger(Events.REPRESENTATION_UPDATED, {sender: this, representation: representation});
    }

    function onSegmentsLoaded(e) {
        if (e.error || (getType() !== e.mediaType)) return;

        const fragments = e.segments;
        const representation = e.representation;
        const segments = [];
        let count = 0;

        let i,
            len,
            s,
            seg;

        for (i = 0, len = fragments.length; i < len; i++) {
            s = fragments[i];

            seg = getTimeBasedSegment(
                timelineConverter,
                isDynamic(),
                representation,
                s.startTime,
                s.duration,
                s.timescale,
                s.media,
                s.mediaRange,
                count);

            segments.push(seg);
            seg = null;
            count++;
        }

        representation.segmentAvailabilityRange = {start: segments[0].presentationStartTime, end: segments[len - 1].presentationStartTime};
        representation.availableSegmentsNumber = len;

        onSegmentListUpdated(representation, segments);

        if (!Representation.hasInitialization(representation)) return;

        eventBus.trigger(Events.REPRESENTATION_UPDATED, {sender: this, representation: representation});
    }

    instance = {
        initialize: initialize,
        getStreamProcessor: getStreamProcessor,
        getInitRequest: getInitRequest,
        getSegmentRequestForTime: getSegmentRequestForTime,
        getNextSegmentRequest: getNextSegmentRequest,
        updateRepresentation: updateRepresentation,
        updateSegmentList: updateSegmentList,
        setCurrentTime: setCurrentTime,
        getCurrentTime: getCurrentTime,
        reset: reset,
        resetIndex: resetIndex
    };

    setup();

    return instance;
}

DashHandler.__dashjs_factory_name = 'DashHandler';
export default FactoryMaker.getClassFactory(DashHandler);
