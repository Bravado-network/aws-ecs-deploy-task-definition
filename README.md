## Amazon ECS "Deploy Task Definition" Action for GitHub Actions

Registers an Amazon ECS task definition and deploys it to an ECS service. If some ECS task fails to initialize or on health checks, it'll rollback to the previous deployment.

**Table of Contents**


- [Usage](#usage)
    + [Task definition file](#task-definition-file)
    + [Task definition container image values](#task-definition-container-image-values)


<!-- tocstop -->

## Usage

```yaml
    - name: Deploy to Amazon ECS
      uses: Bravado-network/aws-ecs-deploy-task-definition@@v1
      with:
        task-definition: task-definition.json
        service: backend
        cluster: ecs-staging-cluster
```

See [action.yml](action.yml) for the full documentation for this action's inputs and outputs.

### Task definition file
Your GitHub Actions workflow can download the existing task definition.
```yaml
    - name: Download task definition
      run: |
        aws ecs describe-task-definition --task-definition my-task-definition-family --query taskDefinition > task-definition.json
```

### Task definition container image values

It is highly recommended that each time your GitHub Actions workflow runs and builds a new container image for deployment, a new container image ID is generated.  For example, use the commit ID as the new image's tag, instead of updating the 'latest' tag with the new image.  Using a unique container image ID for each deployment allows rolling back to a previous container image.

The task definition file can be updated prior to deployment with the new container image ID using [the `Bravado-network/aws-ecs-render-task-definition` action](https://github.com/Bravado-network/aws-ecs-render-task-definition).  The following example builds a new container image tagged with the commit ID, inserts the new image ID as the image for the task definition file, and then deploys the rendered task definition file to ECS:

```yaml
    - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v1
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ secrets.AWS_REGION }}

      - name: Download backend task definition
        run: |
          aws ecs describe-task-definition --task-definition ${{ env.ECS_RAILS_SERVICE_NAME }} \
          --query taskDefinition > backend-task-definition.json

      - name: Fill in the new image ID and env vars from AWS SSM in the Amazon ECS task definition
        id: task-def
        uses: Bravado-network/aws-ecs-render-task-definition@v1.0.1
        with:
          task-definition: backend-task-definition.json
          container-name: ${{ env.ECS_RAILS_SERVICE_NAME }}
          ssm-param-path-pattern: ${{ env.SSM_PARAMS_PATH }}
          image: ${{ env.BACKEND_IMAGE_URI }}

      - name: Deploy Rails
        uses: Bravado-network/aws-ecs-deploy-task-definition@v1
        with:
          task-definition: ${{ steps.task-def.outputs.task-definition }}
          service: ${{ env.ECS_RAILS_SERVICE_NAME }}
          cluster: ${{ env.ECS_CLUSTER_NAME }}
          force-new-deployment: true
```

