/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ContainerError } from '../spec-common/errors';
import { DevContainerConfig, DevContainerConfigCommand, DevContainerFromDockerfileConfig, DevContainerFromImageConfig, getDockerComposeFilePaths, getDockerfilePath, HostRequirements, isDockerFileConfig, PortAttributes, UserEnvProbe } from '../spec-configuration/configuration';
import { Feature, FeaturesConfig, Mount } from '../spec-configuration/containerFeaturesConfiguration';
import { ContainerDetails, DockerCLIParameters, ImageDetails } from '../spec-shutdown/dockerUtils';
import { Log } from '../spec-utils/log';
import { getBuildInfoForService, readDockerComposeConfig } from './dockerCompose';
import { DockerResolverParameters, findBaseImage, findUserStatement, inspectDockerImage, uriToWSLFsPath } from './utils';

const pickConfigProperties: (keyof DevContainerConfig & keyof ImageMetadataEntry)[] = [
	'onCreateCommand',
	'updateContentCommand',
	'postCreateCommand',
	'postStartCommand',
	'postAttachCommand',
	'waitFor',
	'customizations',
	'remoteUser',
	'userEnvProbe',
	'remoteEnv',
	'overrideCommand',
	'portsAttributes',
	'otherPortsAttributes',
	'forwardPorts',
	'shutdownAction',
	'updateRemoteUserUID',
	'hostRequirements',
];

const pickSingleContainerConfigProperties: (keyof DevContainerFromImageConfig & keyof DevContainerFromDockerfileConfig & keyof ImageMetadataEntry)[] = [
	'mounts',
	'containerUser',
	'containerEnv',
	...pickConfigProperties,
];

const pickFeatureProperties: (keyof Feature & keyof ImageMetadataEntry)[] = [
	'id',
	'init',
	'privileged',
	'capAdd',
	'securityOpt',
	'entrypoint',
	'mounts',
	'customizations',
];

export interface ImageMetadataEntry {
	id?: string;
	init?: boolean;
	privileged?: boolean;
	capAdd?: string[];
	securityOpt?: string[];
	entrypoint?: string;
	mounts?: (Mount | string)[];
	customizations?: Record<string, any>;
	onCreateCommand?: string | string[];
	updateContentCommand?: string | string[];
	postCreateCommand?: string | string[];
	postStartCommand?: string | string[];
	postAttachCommand?: string | string[];
	waitFor?: DevContainerConfigCommand;
	remoteUser?: string;
	containerUser?: string;
	userEnvProbe?: UserEnvProbe;
	remoteEnv?: Record<string, string | null>;
	containerEnv?: Record<string, string>;
	overrideCommand?: boolean;
	portsAttributes?: Record<string, PortAttributes>;
	otherPortsAttributes?: PortAttributes;
	forwardPorts?: (number | string)[];
	shutdownAction?: 'none' | 'stopContainer' | 'stopCompose';
	updateRemoteUserUID?: boolean;
	hostRequirements?: HostRequirements;
}

export function getDevcontainerMetadata(devContainerConfig: DevContainerConfig, featuresConfig: FeaturesConfig | Feature[]): ImageMetadataEntry[] {
	const features = Array.isArray(featuresConfig) ? featuresConfig : ([] as Feature[]).concat(
		...featuresConfig.featureSets
			.map(x => x.features)
	);
	return [
		...features.map(feature => pick(feature, pickFeatureProperties)),
		'dockerComposeFile' in devContainerConfig ?
			pick(devContainerConfig, pickConfigProperties) :
			pick(devContainerConfig, pickSingleContainerConfigProperties),
	];
}

function pick<T, K extends keyof T>(obj: T, keys: K[]) {
	return keys.reduce((res, key) => {
		if (key in obj) {
			res[key] = obj[key];
		}
		return res;
	}, {} as Pick<T, K>);
}

export interface ImageBuildInfo {
	user: string;
	metadata: ImageMetadataEntry[];
}

export async function getImageBuildInfo(params: DockerResolverParameters | DockerCLIParameters, config: DevContainerConfig, experimentalImageMetadata: boolean): Promise<ImageBuildInfo> {
	const { dockerCLI, dockerComposeCLI } = params;
	const { cliHost, output } = 'cliHost' in params ? params : params.common;

	if (isDockerFileConfig(config)) {

		const dockerfileUri = getDockerfilePath(cliHost, config);
		const dockerfilePath = await uriToWSLFsPath(dockerfileUri, cliHost);
		if (!cliHost.isFile(dockerfilePath)) {
			throw new ContainerError({ description: `Dockerfile (${dockerfilePath}) not found.` });
		}
		const dockerfile = (await cliHost.readFile(dockerfilePath)).toString();
		return getImageBuildInfoFromDockerfile(params, dockerfile, experimentalImageMetadata);

	} else if ('dockerComposeFile' in config) {

		const cwdEnvFile = cliHost.path.join(cliHost.cwd, '.env');
		const envFile = Array.isArray(config.dockerComposeFile) && config.dockerComposeFile.length === 0 && await cliHost.isFile(cwdEnvFile) ? cwdEnvFile : undefined;
		const composeFiles = await getDockerComposeFilePaths(cliHost, config, cliHost.env, cliHost.cwd);
		const buildParams: DockerCLIParameters = { cliHost, dockerCLI, dockerComposeCLI, env: cliHost.env, output };

		const composeConfig = await readDockerComposeConfig(buildParams, composeFiles, envFile);
		const services = Object.keys(composeConfig.services || {});
		if (services.indexOf(config.service) === -1) {
			throw new Error(`Service '${config.service}' configured in devcontainer.json not found in Docker Compose configuration.`);
		}

		const composeService = composeConfig.services[config.service];
		const serviceInfo = getBuildInfoForService(composeService, cliHost.path, composeFiles);
		if (serviceInfo.build) {
			const { context, dockerfilePath } = serviceInfo.build;
			const resolvedDockerfilePath = cliHost.path.isAbsolute(dockerfilePath) ? dockerfilePath : cliHost.path.resolve(context, dockerfilePath);
			const dockerfile = (await cliHost.readFile(resolvedDockerfilePath)).toString();
			return getImageBuildInfoFromDockerfile(params, dockerfile, experimentalImageMetadata);
		} else {
			return getImageBuildInfoFromImage(params, composeService.image, experimentalImageMetadata);
		}

	} else {

		return getImageBuildInfoFromImage(params, config.image, experimentalImageMetadata);

	}
}

export async function getImageBuildInfoFromImage(params: DockerResolverParameters | DockerCLIParameters, imageName: string, experimentalImageMetadata: boolean): Promise<ImageBuildInfo & { imageDetails: ImageDetails }> {
	const imageDetails = await inspectDockerImage(params, imageName, true);
	const user = imageDetails.Config.User || 'root';
	const { output } = 'output' in params ? params : params.common;
	const metadata = getImageMetadata(imageDetails, experimentalImageMetadata, output);
	return {
		user,
		metadata,
		imageDetails,
	};
}

export async function getImageBuildInfoFromDockerfile(params: DockerResolverParameters | DockerCLIParameters, dockerfile: string, experimentalImageMetadata: boolean) {
	const { output } = 'output' in params ? params : params.common;
	return internalGetImageBuildInfoFromDockerfile(imageName => inspectDockerImage(params, imageName, true), dockerfile, experimentalImageMetadata, output);
}

export async function internalGetImageBuildInfoFromDockerfile(inspectDockerImage: (imageName: string) => Promise<ImageDetails>, dockerfile: string, experimentalImageMetadata: boolean, output: Log): Promise<ImageBuildInfo> {
	// TODO: Other targets.
	const dockerfileUser = findUserStatement(dockerfile);
	const baseImage = findBaseImage(dockerfile);
	const imageDetails = baseImage && await inspectDockerImage(baseImage) || undefined;
	const user = dockerfileUser || imageDetails?.Config.User || 'root';
	const metadata = imageDetails ? getImageMetadata(imageDetails, experimentalImageMetadata, output) : [];
	return {
		user,
		metadata,
	};
}

export const imageMetadataLabel = 'devcontainer.metadata';

export function getImageMetadataFromContainer(containerDetails: ContainerDetails, devContainerConfig: DevContainerConfig, featuresConfig: FeaturesConfig | Feature[], experimentalImageMetadata: boolean, output: Log) {
	if (!experimentalImageMetadata) {
		return getDevcontainerMetadata(devContainerConfig, featuresConfig);
	}
	return internalGetImageMetadata(containerDetails, experimentalImageMetadata, output);
}

export function getImageMetadata(imageDetails: ImageDetails, experimentalImageMetadata: boolean, output: Log) {
	return internalGetImageMetadata(imageDetails, experimentalImageMetadata, output);
}

function internalGetImageMetadata(imageDetails: ImageDetails | ContainerDetails, experimentalImageMetadata: boolean, output: Log) {
	if (!experimentalImageMetadata) {
		return [];
	}
	const str = (imageDetails.Config.Labels || {})[imageMetadataLabel];
	if (str) {
		try {
			const obj = JSON.parse(str);
			if (Array.isArray(obj)) {
				return obj as ImageMetadataEntry[];
			}
			if (obj && typeof obj === 'object') {
				return [obj as ImageMetadataEntry];
			}
			output.write(`Invalid image metadata: ${str}`);
		} catch (err) {
			output.write(`Error parsing image metadata: ${err?.message || err}`);
		}
	}
	return [];
}

export function getDevcontainerMetadataLabel(baseImageMetadata: ImageMetadataEntry[], devContainerConfig: DevContainerConfig, featuresConfig: FeaturesConfig | Feature[], experimentalImageMetadata: boolean) {
	if (!experimentalImageMetadata) {
		return '';
	}
	const metadata: ImageMetadataEntry[] = [
		...baseImageMetadata,
		...getDevcontainerMetadata(devContainerConfig, featuresConfig),
	];
	if (!metadata.length) {
		return '';
	}
	const imageMetadataLabelValue = metadata.length !== 1
		? `[${metadata
			.map(feature => ` \\\n${toLabelString(feature)}`)
			.join(',')} \\\n]`
		: toLabelString(metadata[0]);
	return `LABEL ${imageMetadataLabel}="${imageMetadataLabelValue}"`;
}

function toLabelString(obj: object) {
	return JSON.stringify(obj)
		.replace(/(?=["\\$])/g, '\\');
}